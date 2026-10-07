import { posix } from "node:path";
import { vispError } from "../../core/errors.js";
import { resolveCommand } from "../../core/exec.js";
import { ProjectFileSystem } from "../../core/fs.js";
import { matchesAny } from "../../core/patterns.js";
import { err, ok } from "../../core/result.js";
import { isApplicationSource } from "../../graph/coverage-notes.js";
import { extractImports } from "../../graph/extract/imports.js";
import { type ParsedTree, parseSource } from "../../graph/extract/parser.js";
import { createResolutionContext, resolveScriptImport } from "../../graph/extract/resolve.js";
import { loadAliases } from "../../graph/extract/tsconfig.js";
import { grammarForPath, isTestPath } from "../../graph/paths.js";
import type { WorkspaceState } from "../state.js";
import { isBrowserCheckCommand } from "./check-command.js";
import { pythonImplementationImports } from "./flip-python-imports.js";
import type { FlipEntry } from "./flip-tree.js";
import type { ProductCheck } from "./model.js";
import { reviewCheckPaths } from "./review-check-context.js";
import { MISSING_SOURCE_ENTRY } from "./source-entry.js";

/** Test directories also contain fixtures and assertion helpers without test-shaped names. */
export function flipTestPath(path: string) {
  return isTestPath(path) || /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(path);
}

/**
 * Declarations nominate validation inputs, not an implementation exemption. Production
 * directories remain implementation even when declared; imports from application code
 * (in either baseline or current source) override every nomination, transitively.
 * Rule: a changed file is validation only when it is test-shaped, or declared AND outside the
 * production source roots AND either application code or inside a validation-shaped directory
 * (fixtures, snapshots, golden outputs), AND no production module statically reaches it. Every
 * other changed file is implementation, including declared data the product reads at runtime.
 * Literal dynamic imports count as reachable; computed ones are ignored. Unparseable Python, or a
 * relative or project-owned Python import that cannot be resolved, yields an error, which the
 * caller reports as unchecked.
 */
export async function flipValidationPaths(
  workspace: WorkspaceState,
  check: ProductCheck,
  snapshot: Record<string, string>,
  baseline: ReadonlyMap<string, FlipEntry>,
  baselineIdentities: Record<string, string> = {},
): Promise<Set<string>> {
  const paths = new Set([...Object.keys(snapshot), ...baseline.keys()]);
  const argv = isBrowserCheckCommand(check.command) ? undefined : resolveCommand(check.command);
  const syntaxOnly = argv?.ok && argv.value.includes("--check");
  const declared = new Set(await reviewCheckPaths(workspace, [check], snapshot));
  const candidates = new Set(
    [...paths].filter(
      (path) => flipTestPath(path) || (declared.has(path) && declaredValidation(path)),
    ),
  );
  const publicPaths = [...(await publicModulePaths(workspace, baseline, paths))];
  const roots = [...paths].filter(
    (path) => implementationRoot(path, !!syntaxOnly) || matchesAny(path, publicPaths),
  );
  if (!roots.length) return candidates;
  const current = createResolutionContext(paths, await loadAliases(workspace.paths.root));
  const aliases = await loadAliases(
    workspace.paths.root,
    "tsconfig.json",
    new FlipBaselineFiles(workspace.paths.root, baseline, baselineIdentities),
  );
  if (aliases.problems.length)
    throw new Error(`baseline import configuration unavailable: ${aliases.problems.join(", ")}`);
  const contexts = { current, baseline: { ...current, aliases } };
  const visited = new Set<string>();
  let bytes = 0;
  const queue = [...roots];
  while (queue.length) {
    const path = queue.pop() as string;
    if (visited.has(path)) continue;
    visited.add(path);
    candidates.delete(path);
    const imports = await implementationImports(workspace, path, baseline, contexts);
    bytes += imports.bytes;
    if (bytes > 64 * 1024 * 1024) throw new Error("implementation import inspection byte limit");
    queue.push(...imports.paths);
  }
  return candidates;
}

async function implementationImports(
  workspace: WorkspaceState,
  path: string,
  baseline: ReadonlyMap<string, FlipEntry>,
  contexts: {
    current: ReturnType<typeof createResolutionContext>;
    baseline: ReturnType<typeof createResolutionContext>;
  },
) {
  const grammar = grammarForPath(path);
  const paths: string[] = [];
  let bytes = 0;
  if (!grammar) return { paths, bytes };
  const read = await workspace.files.readTextIfExists(path);
  if (!read.ok) throw new Error(`cannot inspect implementation imports in ${path}`);
  const old = baseline.get(path);
  const previous = old?.bytes && !old.symlink ? Buffer.from(old.bytes).toString("utf8") : undefined;
  const inputs = [{ text: read.value, context: contexts.current }];
  if (
    previous !== read.value ||
    JSON.stringify(contexts.baseline.aliases.aliases) !==
      JSON.stringify(contexts.current.aliases.aliases)
  )
    inputs.push({ text: previous, context: contexts.baseline });
  for (const { text, context } of inputs) {
    if (text === undefined) continue;
    bytes += Buffer.byteLength(text);
    paths.push(...(await importsOfText(path, grammar, text, context)));
  }
  return { paths, bytes };
}

async function importsOfText(
  path: string,
  grammar: NonNullable<ReturnType<typeof grammarForPath>>,
  text: string,
  context: ReturnType<typeof createResolutionContext>,
) {
  const parsed = await parseSource(grammar, text);
  if (parsed.kind !== "parsed") throw new Error(`cannot inspect implementation imports in ${path}`);
  try {
    if (parsed.tree.hasError) {
      // Unparseable Python could import a candidate test module, so reachability is unknown.
      // Other unparseable source (a JavaScript template, say) contributes no import edges.
      if (parsed.tree.grammar === "python")
        throw new Error(
          `implementation import reachability unavailable in ${path}: incomplete parse`,
        );
      return [];
    }
    const imports = extractImports(path, parsed.tree, context, new Map());
    return [
      ...imports.importedFiles,
      ...additionalImplementationImports(path, parsed.tree, context),
    ];
  } finally {
    parsed.dispose();
  }
}

/**
 * Edges the extractor cannot list itself. Python needs the submodule and dynamic-import
 * rules in flip-python-imports.ts. JavaScript needs none: an unresolved static import names
 * a file absent from the snapshot, so it cannot make a candidate reachable; a computed
 * dynamic import is ignored, as for Python; an unresolved call names no module.
 */
function additionalImplementationImports(
  path: string,
  tree: ParsedTree,
  context: ReturnType<typeof createResolutionContext>,
) {
  return tree.grammar === "python" ? pythonImplementationImports(path, tree, context) : [];
}

/** Application directories: a declaration cannot make their files validation, whatever their type. */
function productionSourceRoot(path: string) {
  return /(?:^|\/)(?:src|lib|app|django)(?:\/|$)/.test(path);
}

/** Directories that hold a check's inputs (fixtures, snapshots, golden outputs), not product data. */
const VALIDATION_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "fixtures",
  "fixture",
  "testdata",
  "test_data",
  "__snapshots__",
  "snapshots",
  "expected",
  "golden",
]);

/**
 * A declaration nominates validation only outside production source roots. Application code
 * qualifies on that alone; a declared data file (config, defaults) qualifies only inside a
 * validation-shaped directory, so a data file the product reads is implementation.
 */
function declaredValidation(path: string) {
  if (productionSourceRoot(path)) return false;
  return (
    isApplicationSource(path) ||
    path
      .split("/")
      .slice(0, -1)
      .some((segment) => VALIDATION_DIRECTORIES.has(segment))
  );
}

function implementationRoot(path: string, syntaxOnly: boolean) {
  if (!isApplicationSource(path) || flipTestPath(path)) return false;
  if (path.endsWith("/__init__.py")) return true;
  if (syntaxOnly || /(?:^|\/)(?:src|lib|app|django)(?:\/|$)/.test(path)) return true;
  // Worker declarations never decide roots. Only intrinsically validation-shaped paths
  // can be nominated; ambiguous root-level source is always implementation.
  return !/(?:^|\/)(?:quality|checks?|validation|verifiers?|assertions?|fixtures?)(?:\/|$)/.test(
    path,
  );
}

async function publicModulePaths(
  workspace: WorkspaceState,
  baseline: ReadonlyMap<string, FlipEntry>,
  sourcePaths: ReadonlySet<string>,
) {
  const paths = new Set<string>();
  for (const manifestPath of new Set([
    "package.json",
    ...[...sourcePaths].filter((path) => path.endsWith("/package.json")),
  ])) {
    const current = await workspace.files.readTextIfExists(manifestPath);
    if (!current.ok) throw new Error("cannot inspect public module entry points");
    for (const text of [
      current.value,
      baseline.get(manifestPath)?.bytes &&
        Buffer.from(baseline.get(manifestPath)?.bytes as Uint8Array).toString("utf8"),
    ]) {
      if (!text) continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(text);
      } catch {
        throw new Error("cannot inspect public module entry points");
      }
      for (const key of ["main", "module", "exports", "bin"])
        collectPublicTargets(manifest[key], manifestPath, paths, sourcePaths);
    }
  }
  return paths;
}

function collectPublicTargets(
  value: unknown,
  manifestPath: string,
  paths: Set<string>,
  sourcePaths: ReadonlySet<string>,
) {
  if (typeof value === "string") {
    const target = posix.join(posix.dirname(manifestPath), value);
    paths.add(target);
    paths.add(target.replace(/\.[cm]?js$/, ".ts"));
    if (!posix.extname(target)) paths.add(`${target}/index.*`);
    const resolved = resolveScriptImport(
      { files: sourcePaths, aliases: { aliases: [], problems: [] } },
      manifestPath,
      value.startsWith(".") ? value : `./${value}`,
    );
    if (resolved.kind === "file") paths.add(resolved.path);
  } else if (value && typeof value === "object")
    for (const child of Object.values(value))
      collectPublicTargets(child, manifestPath, paths, sourcePaths);
}

/** Alias resolution for the old source must read old configuration, never today's overlay. */
class FlipBaselineFiles extends ProjectFileSystem {
  constructor(
    root: string,
    private readonly entries: ReadonlyMap<string, FlipEntry>,
    private readonly identities: Record<string, string>,
  ) {
    super(root);
  }
  override async readTextIfExists(path: string) {
    const entry = this.entries.get(path);
    if (
      entry?.symlink ||
      (this.identities[path] !== undefined &&
        this.identities[path] !== MISSING_SOURCE_ENTRY &&
        !entry)
    )
      return err(vispError("IO_ERROR", `baseline configuration bytes unavailable for ${path}`));
    return ok(entry?.bytes === undefined ? undefined : Buffer.from(entry.bytes).toString("utf8"));
  }
}
