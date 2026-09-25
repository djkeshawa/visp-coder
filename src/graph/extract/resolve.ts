import { externalRef, INDEX_BASENAMES, RESOLVE_EXTENSIONS } from "../constants.js";
import { dirname, joinPosix } from "../paths.js";
import type { AliasTable, PathAlias } from "./tsconfig.js";

/**
 * Import resolution against the walked file set. Nothing is invented: a
 * specifier either lands on a walked file, is plainly external, or is unresolved.
 */
export type Resolution =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "external"; readonly ref: string }
  | { readonly kind: "unresolved"; readonly detail: string };

export interface ResolutionContext {
  readonly files: ReadonlySet<string>;
  readonly aliases: AliasTable;
}

export function createResolutionContext(
  files: Iterable<string>,
  aliases: AliasTable,
): ResolutionContext {
  return { files: new Set(files), aliases };
}

export function resolveScriptImport(
  context: ResolutionContext,
  fromPath: string,
  specifier: string,
): Resolution {
  if (specifier.startsWith(".")) {
    const base = joinPosix(dirname(fromPath), specifier);
    const hit = probe(context, base);
    return hit ? { kind: "file", path: hit } : { kind: "unresolved", detail: specifier };
  }

  const aliased = resolveAlias(context, specifier);
  if (aliased) return aliased;
  if (specifier.startsWith("/")) return { kind: "unresolved", detail: specifier };
  return { kind: "external", ref: externalRef(specifier) };
}

function resolveAlias(context: ResolutionContext, specifier: string): Resolution | undefined {
  let matched = false;
  for (const alias of context.aliases.aliases) {
    const substituted = substitute(alias, specifier);
    if (substituted.length === 0) continue;
    matched = true;
    for (const candidate of substituted) {
      const hit = probe(context, candidate);
      if (hit) return { kind: "file", path: hit };
    }
  }
  return matched ? { kind: "unresolved", detail: specifier } : undefined;
}

function substitute(alias: PathAlias, specifier: string): string[] {
  const star = alias.pattern.indexOf("*");
  if (star === -1) {
    return alias.pattern === specifier ? [...alias.targets] : [];
  }

  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
  if (specifier.length < prefix.length + suffix.length) return [];

  const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
  return alias.targets.map((target) => target.replace("*", captured));
}

/**
 * TypeScript ESM sources import `./x.js` and mean `./x.ts`, so a JavaScript
 * extension is also tried against its TypeScript sources.
 */
function probe(context: ResolutionContext, base: string): string | undefined {
  if (base === "") return undefined;
  for (const candidate of scriptCandidates(base)) {
    if (context.files.has(candidate)) return candidate;
  }
  return undefined;
}

function scriptCandidates(base: string): string[] {
  const candidates: string[] = [base];
  const rewritten = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const stems = rewritten === base ? [base] : [rewritten, base];

  for (const stem of stems) {
    for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${stem}${extension}`);
  }
  for (const indexName of INDEX_BASENAMES) {
    for (const extension of RESOLVE_EXTENSIONS) {
      candidates.push(`${base}/${indexName}${extension}`);
    }
  }
  return candidates;
}

/**
 * Python resolution. Leading dots are package-relative; a dotted name is tried
 * against the repository before being called external.
 */
export function resolvePythonImport(
  context: ResolutionContext,
  fromPath: string,
  specifier: string,
): Resolution {
  const dots = countLeadingDots(specifier);
  const moduleName = specifier.slice(dots);

  if (dots > 0) {
    const base = ascend(dirname(fromPath), dots - 1);
    if (base === undefined) return { kind: "unresolved", detail: specifier };
    const hit = probePython(context, joinPosix(base, moduleName.split(".").join("/")));
    return hit ? { kind: "file", path: hit } : { kind: "unresolved", detail: specifier };
  }

  const hit = probePython(context, moduleName.split(".").join("/"));
  return hit ? { kind: "file", path: hit } : { kind: "external", ref: externalRef(specifier) };
}

function probePython(context: ResolutionContext, base: string): string | undefined {
  if (base === "") return undefined;
  for (const candidate of [`${base}.py`, `${base}.pyi`, `${base}/__init__.py`]) {
    if (context.files.has(candidate)) return candidate;
  }
  return undefined;
}

function ascend(directory: string, levels: number): string | undefined {
  let current = directory;
  for (let index = 0; index < levels; index += 1) {
    if (current === "") return undefined;
    current = dirname(current);
  }
  return current;
}

function countLeadingDots(specifier: string): number {
  let count = 0;
  while (specifier[count] === ".") count += 1;
  return count;
}
