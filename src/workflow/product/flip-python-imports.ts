import {
  argumentsOf,
  dottedName,
  field,
  named,
  stringValue,
  walkNamed,
} from "../../graph/extract/nodes.js";
import type { ParsedTree, SyntaxNode } from "../../graph/extract/parser.js";
import { type ResolutionContext, resolvePythonImport } from "../../graph/extract/resolve.js";

const DYNAMIC_IMPORT_CALLEES = new Set([
  "import_module",
  "importlib.import_module",
  "__import__",
  "builtins.__import__",
]);
const IMPORT_MODULES = new Set(["importlib", "builtins"]);

export function pythonImplementationImports(
  path: string,
  tree: ParsedTree,
  context: ResolutionContext,
) {
  const paths = new Set<string>();
  const follow = (specifier: string, optional = false) => {
    const resolution = resolvePythonImport(context, path, specifier);
    if (resolution.kind === "file") paths.add(resolution.path);
    else if (
      resolution.kind === "unresolved" &&
      !optional &&
      (specifier.startsWith(".") || projectTopLevel(context, specifier))
    )
      throw new Error(
        `Python implementation import reachability unavailable in ${path}: ${specifier}`,
      );
    // Importing pkg.mod executes package initializers as well as the submodule.
    const dots = specifier.match(/^\.*/)?.[0] ?? "";
    const components = specifier.slice(dots.length).split(".");
    for (let count = 1; count < components.length; count++) {
      const parent = resolvePythonImport(
        context,
        path,
        dots + components.slice(0, count).join("."),
      );
      if (parent.kind === "file") paths.add(parent.path);
    }
  };
  const aliases = dynamicImportAliases(tree);
  walkNamed(tree.root, (node) => {
    if (node.type === "call") {
      followDynamicImport(node, aliases, follow);
      return true;
    }
    if (node.type === "import_statement") {
      for (const child of named(node)) follow(field(child, "name")?.text ?? child.text);
      return false;
    }
    if (node.type !== "import_from_statement") return true;
    followFromImport(node, path, context, follow);
    return false;
  });
  return [...paths];
}

/** The imported name and its local alias from `name as alias`; undefined for a plain name. */
function aliasPair(child: SyntaxNode): [string, string] | undefined {
  if (child.type !== "aliased_import") return undefined;
  const real = field(child, "name")?.text;
  const local = field(child, "alias")?.text;
  return real && local ? [real, local] : undefined;
}

/**
 * Local names that stand for importlib.import_module or builtins.__import__, from
 * `from importlib import import_module as im` and `import importlib as il`.
 */
function dynamicImportAliases(tree: ParsedTree) {
  const modules = new Map<string, string>();
  const callables = new Map<string, string>();
  walkNamed(tree.root, (node) => {
    if (node.type === "import_statement") recordModuleAliases(node, modules);
    else if (node.type === "import_from_statement") recordCallableAliases(node, callables);
    return true;
  });
  return { modules, callables };
}

function recordModuleAliases(node: SyntaxNode, modules: Map<string, string>) {
  for (const child of named(node)) {
    const [real, local] = aliasPair(child) ?? [];
    if (real && local && IMPORT_MODULES.has(real)) modules.set(local, real);
  }
}

function recordCallableAliases(node: SyntaxNode, callables: Map<string, string>) {
  const module = field(node, "module_name")?.text ?? "";
  if (!IMPORT_MODULES.has(module)) return;
  for (const child of named(node)) {
    const [real, local] = aliasPair(child) ?? [];
    if (real && local) callables.set(local, `${module}.${real}`);
  }
}

/** The dotted name a call's callee denotes once its local alias, if any, is resolved. */
function resolvedCallee(callee: string, aliases: ReturnType<typeof dynamicImportAliases>): string {
  const callable = aliases.callables.get(callee);
  if (callable !== undefined) return callable;
  const [head, ...rest] = callee.split(".");
  const module = aliases.modules.get(head ?? "");
  return module !== undefined && rest.length > 0 ? [module, ...rest].join(".") : callee;
}

/**
 * Reachability rule for dynamic imports. A call whose module name is a literal string
 * (import_module("pkg.mod"), __import__("pkg.mod")) makes that module reachable exactly
 * like a static import, including through an alias of import_module or __import__. A
 * computed name is not guessed at, so it is ignored: treating every computed import as
 * unknowable would leave whole frameworks (Django loads settings with import_module) without
 * a result. Code run through eval/exec is not analysed.
 */
function followDynamicImport(
  call: SyntaxNode,
  aliases: ReturnType<typeof dynamicImportAliases>,
  follow: (specifier: string, optional?: boolean) => void,
) {
  const written = dottedName(field(call, "function"));
  const callee = written === undefined ? undefined : resolvedCallee(written, aliases);
  if (callee === undefined || !DYNAMIC_IMPORT_CALLEES.has(callee)) return;
  const args = argumentsOf(call);
  const name = literalModule(args[0]);
  // A relative name resolves against a package the call's second argument supplies at runtime.
  if (name === undefined || (name.startsWith(".") && args.length > 1)) return;
  follow(name, true);
}

/**
 * Absolute imports resolve from top-level import roots. The resolver's package heuristic
 * also counts package names nested under a root (django/http makes "http" look
 * project-owned, shadowing stdlib http.client), so an unresolved absolute name is
 * uncertain only when the project has that top-level package or module at a root.
 */
function projectTopLevel(context: ResolutionContext, specifier: string): boolean {
  const top = specifier.split(".")[0] ?? "";
  if (!top) return false;
  return ["", "src"].some((root) => {
    const base = root ? `${root}/${top}` : top;
    if (
      context.files.has(`${base}.py`) ||
      context.files.has(`${base}.pyi`) ||
      context.files.has(`${base}/__init__.py`)
    )
      return true;
    return [...context.files].some((file) => file.startsWith(`${base}/`));
  });
}

function literalModule(node: SyntaxNode | undefined) {
  if (!node || named(node).some((child) => child.type === "interpolation")) return undefined;
  return stringValue(node);
}

function followFromImport(
  node: SyntaxNode,
  path: string,
  context: ResolutionContext,
  follow: (specifier: string, optional?: boolean) => void,
) {
  const moduleNode = field(node, "module_name");
  const module = moduleNode?.text ?? "";
  const submodules: string[] = [];
  for (const child of named(node)) {
    // Tree-sitter returns a fresh wrapper per access, so identity cannot tell the module apart.
    if (moduleNode && sameSpan(child, moduleNode)) continue;
    const name = field(child, "name")?.text ?? child.text;
    if (name === "*") continue;
    const submodule = module + (module.endsWith(".") ? "" : ".") + name;
    const resolved = resolvePythonImport(context, path, submodule);
    if (resolved.kind === "file") submodules.push(submodule);
  }
  // A namespace package may have no __init__.py, yet its submodule is resolvable.
  follow(module, submodules.length > 0);
  for (const submodule of submodules) follow(submodule);
}

function sameSpan(a: SyntaxNode, b: SyntaxNode) {
  return (
    a.startPosition.row === b.startPosition.row &&
    a.startPosition.column === b.startPosition.column &&
    a.endPosition.row === b.endPosition.row &&
    a.endPosition.column === b.endPosition.column
  );
}
