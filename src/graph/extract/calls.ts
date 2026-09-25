import { isExternalRef } from "../constants.js";
import { fileEntityId } from "../ids.js";
import type { Entity, Relation, UnknownRecord } from "../types.js";
import { dottedName, field, lineOf, walkNamed } from "./nodes.js";
import type { ParsedTree, SyntaxNode } from "./parser.js";
import { UnknownCollector } from "./unknowns.js";

/**
 * Call extraction is name-based and file-scoped, by design. A call through a
 * runtime value cannot be bound by a name, so it is reported as an unknown
 * rather than attached to a plausible-looking target.
 */

export interface CallSite {
  readonly path: string;
  /** Text before the final dot, when the callee was a member expression. */
  readonly qualifier: string | undefined;
  readonly name: string;
  readonly line: number;
  readonly text: string;
}

const IGNORED_CALLEES = new Set(["import", "require", "super"]);
const SELF_QUALIFIERS = new Set(["this", "self", "cls"]);

/**
 * Runtime globals a call could never resolve to a repository entity. In every
 * real run these were 96–100% of the unknown noise — ten pack slots spent
 * telling an agent that `Math.pow` could not be resolved — and each one
 * drowned an unknown a reader should actually act on.
 */
const KNOWN_GLOBALS = new Set([
  // JavaScript / browser / node
  ...["Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "Date", "RegExp"],
  ...["Promise", "Symbol", "Reflect", "Proxy", "Error", "TypeError", "RangeError", "Map", "Set"],
  ...["WeakMap", "WeakSet", "Intl", "Atomics", "BigInt", "ArrayBuffer", "DataView", "Float32Array"],
  ...["Float64Array", "Int8Array", "Int16Array", "Int32Array", "Uint8Array", "Uint16Array"],
  ...["Uint32Array", "globalThis", "window", "document", "navigator", "performance", "console"],
  ...["process", "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "crypto"],
  ...["localStorage", "sessionStorage", "history", "location", "screen", "AudioContext"],
  ...["parseInt", "parseFloat", "isNaN", "isFinite", "fetch", "alert", "btoa", "atob"],
  ...["setTimeout", "setInterval", "clearTimeout", "clearInterval", "queueMicrotask"],
  ...["requestAnimationFrame", "cancelAnimationFrame", "structuredClone", "encodeURIComponent"],
  ...["decodeURIComponent", "encodeURI", "decodeURI"],
  // Python builtins
  ...["print", "len", "range", "str", "int", "float", "list", "dict", "set", "tuple", "bool"],
  ...["isinstance", "issubclass", "enumerate", "zip", "map", "filter", "sorted", "reversed"],
  ...["min", "max", "sum", "abs", "round", "divmod", "pow", "open", "super", "type", "iter"],
  ...["next", "getattr", "setattr", "hasattr", "delattr", "repr", "format", "vars", "dir"],
  ...["id", "hash", "callable", "any", "all", "ord", "chr", "input", "bytes", "bytearray"],
  ...["frozenset", "slice", "memoryview", "staticmethod", "classmethod", "property"],
]);

export function collectCallSites(path: string, tree: ParsedTree): CallSite[] {
  const callType = tree.grammar === "python" ? "call" : "call_expression";
  const sites: CallSite[] = [];

  walkNamed(tree.root, (node) => {
    if (node.type !== callType) return true;
    const site = describeCall(path, node);
    if (site) sites.push(site);
    return true;
  });
  return sites;
}

function describeCall(path: string, node: SyntaxNode): CallSite | undefined {
  const callee = field(node, "function");
  if (!callee) return undefined;

  const dotted = dottedName(callee);
  if (dotted === undefined) return undefined;

  const lastDot = dotted.lastIndexOf(".");
  const name = lastDot === -1 ? dotted : dotted.slice(lastDot + 1);
  if (IGNORED_CALLEES.has(name)) return undefined;

  return {
    path,
    qualifier: lastDot === -1 ? undefined : dotted.slice(0, lastDot),
    name,
    line: lineOf(node),
    text: dotted,
  };
}

export interface CallScope {
  readonly path: string;
  /** Entities declared in this file, by name. */
  readonly local: ReadonlyMap<string, Entity>;
  /** Imported binding name to a repository file path or an `external:` ref. */
  readonly bindings: ReadonlyMap<string, string>;
  /** Every file's entities, by name, for resolving through an import. */
  readonly byFile: ReadonlyMap<string, ReadonlyMap<string, Entity>>;
  /** Per file, the names it re-exports and where they actually live. */
  readonly reexports?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Entities of this file, ordered so the innermost enclosing one can be found. */
  readonly enclosing: readonly Entity[];
}

export interface CallExtraction {
  readonly relations: Relation[];
  readonly unknowns: UnknownRecord[];
}

export function resolveCalls(sites: readonly CallSite[], scope: CallScope): CallExtraction {
  const relations: Relation[] = [];
  const unknowns = new UnknownCollector();

  for (const site of sites) {
    const target = resolveTarget(site, scope);
    if (target === "external" || target === "global") {
      // A call into a dependency the import edge already records, or into the
      // runtime itself, is not an unknown — writing it down as one is what
      // buried the real gaps under Math.pow.
      continue;
    }
    if (target) {
      relations.push({
        source: enclosingEntityId(scope, site.line),
        target: target.id,
        kind: "calls",
        path: scope.path,
        line: site.line,
      });
      continue;
    }
    unknowns.record("unresolved_call", scope.path, site.text);
  }

  return { relations, unknowns: unknowns.toArray() };
}

type ResolvedTarget = Entity | "external" | "global" | undefined;

function resolveTarget(site: CallSite, scope: CallScope): ResolvedTarget {
  if (site.qualifier === undefined) {
    return (
      scope.local.get(site.name) ??
      throughImport(site.name, site.name, scope) ??
      (KNOWN_GLOBALS.has(site.name) ? "global" : undefined)
    );
  }
  if (SELF_QUALIFIERS.has(site.qualifier)) return scope.local.get(site.name);

  const resolved = throughImport(site.qualifier, site.name, scope);
  if (resolved) return resolved;

  // `THREE.MathUtils.clamp` never matches a binding whole, but its root does:
  // anything reached under an external namespace is the dependency's business.
  const root = site.qualifier.split(".", 1)[0] ?? site.qualifier;
  const rootTarget = scope.bindings.get(root);
  if (rootTarget !== undefined && isExternalRef(rootTarget)) return "external";

  return KNOWN_GLOBALS.has(root) ? "global" : undefined;
}

function throughImport(binding: string, name: string, scope: CallScope): ResolvedTarget {
  const modulePath = scope.bindings.get(binding);
  if (modulePath === undefined) return undefined;
  if (isExternalRef(modulePath)) return "external";

  const direct = scope.byFile.get(modulePath)?.get(name);
  if (direct) return direct;

  // One re-export hop: `export { x } from "./y"` in a barrel means the entity
  // lives in y, and a call bound to the barrel used to be unresolvable.
  const origin = scope.reexports?.get(modulePath)?.get(name);
  return origin ? scope.byFile.get(origin)?.get(name) : undefined;
}

/** The innermost function-like entity around a line, or the file itself. */
export function enclosingEntityId(scope: CallScope, line: number): string {
  let best: Entity | undefined;
  for (const entity of scope.enclosing) {
    if (entity.kind === "file") continue;
    if (entity.startLine > line || entity.endLine < line) continue;
    if (!best || entity.startLine > best.startLine) best = entity;
  }
  return best?.id ?? fileEntityId(scope.path);
}
