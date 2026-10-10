import { posix } from "node:path";
import { matchesAny } from "../../core/patterns.js";
import { privatePath } from "../../core/redaction.js";
import type { WorkspaceState } from "../state.js";
import type { ProductCheck, ProductSlice } from "./model.js";
import { MISSING_SOURCE_ENTRY } from "./source-entry.js";
import type { ProductRecord } from "./store.js";

/**
 * Core sources must each reach the reviewer in some form, and one packet lists about this many
 * (~500 serialized characters per excerpted source within the 32k source budget). A scope that
 * maps more files is a permission boundary, not a relevance signal: in an existing repository a
 * `**` scope makes every file core, so no outcome is assessable and the packet cannot fit.
 */
export const CORE_SCOPE_FILE_LIMIT = 64;
/** Unchanged files the change imports, offered as bounded context when the scope is too broad. */
const NEIGHBOR_LIMIT = 24;

export interface CoreReviewPaths {
  readonly core: Map<string, string[]>;
  /** Set when the scope was too broad to serve as core; core is then the change itself. */
  readonly broad?: {
    readonly scoped: number;
    readonly neighbors: readonly string[];
    /** Changed paths absent now (deleted, or a rename's old path); the diff shows them. */
    readonly deleted: readonly string[];
  };
}

/** Scope is deliberately conservative: lexical relevance cannot prove a file is nonessential. */
export async function coreReviewPaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  checks: readonly { check: ProductCheck; paths: string[] }[],
  slice?: ProductSlice,
  changed: ReadonlySet<string> = new Set(),
  readSource = workspace.files.readTextIfExists.bind(workspace.files),
): Promise<CoreReviewPaths> {
  const slices = slice ? [slice] : record.brief.slices;
  const paths = Object.keys(snapshot).filter((path) => !privatePath(path));
  const verifierEntries = new Set(checks.flatMap(({ paths }) => paths));
  const references = referenceReader(readSource, paths);
  const outcomes = record.brief.outcomes.filter(
    (entry) => entry.priority === "must" && (!slice || slice.outcomes.includes(entry.id)),
  );
  const scoped = paths.filter((path) =>
    matchesAny(
      path,
      slices.flatMap((entry) => [...entry.scope.allowed, ...entry.scope.expected]),
    ),
  ).length;
  const core =
    scoped > CORE_SCOPE_FILE_LIMIT
      ? undefined
      : await scopeCore(outcomes, slices, checks, paths, references, changed);
  if (!core) {
    const present = paths.filter((path) => snapshot[path] !== MISSING_SOURCE_ENTRY);
    const remaining = new Set(present);
    return {
      core: changeCore(present, outcomes, changed),
      broad: {
        scoped,
        neighbors: await changeNeighbors(present, changed, references),
        deleted: [...changed].filter((path) => !remaining.has(path) && !privatePath(path)).sort(),
      },
    };
  }
  return {
    core: new Map(
      [...core].sort(
        ([a], [b]) =>
          Number(productEntry(b)) - Number(productEntry(a)) ||
          Number(changed.has(b)) - Number(changed.has(a)) ||
          Number(verifierEntries.has(a)) - Number(verifierEntries.has(b)),
      ),
    ),
  };
}

/** Scope, check inputs and their dependencies; undefined once it outgrows one review. */
async function scopeCore(
  outcomes: readonly { id: string }[],
  slices: readonly ProductSlice[],
  checks: readonly { check: ProductCheck; paths: string[] }[],
  implementation: string[],
  references: (path: string) => Promise<string[]>,
  changed: ReadonlySet<string>,
) {
  // Check inputs wider than one review (a whole test suite, alone or across several checks of
  // one outcome) are no narrow relevance set either, and following each would read the repository.
  const wide = outcomes.some(
    (outcome) =>
      new Set(
        checks
          .filter(({ check }) => check.outcomes.includes(outcome.id))
          .flatMap(({ paths }) => paths),
      ).size > CORE_SCOPE_FILE_LIMIT,
  );
  if (wide) return undefined;
  const core = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const roots = await outcomeRoots(
      outcome.id,
      slices,
      checks,
      implementation,
      references,
      changed,
    );
    if (!(await addOutcomeRoots(core, outcome.id, roots, references))) return undefined;
  }
  const allowed = slices.flatMap((entry) => entry.scope.allowed);
  for (const path of implementation)
    if (!core.has(path) && (changed.has(path) || matchesAny(path, allowed))) core.set(path, []);
  return core.size > CORE_SCOPE_FILE_LIMIT ? undefined : core;
}

/** Adds roots and their dependencies; false once core outgrows one review. */
async function addOutcomeRoots(
  core: Map<string, string[]>,
  outcome: string,
  roots: Set<string>,
  references: (path: string) => Promise<string[]>,
) {
  for (const path of roots) {
    const owners = core.get(path) ?? [];
    owners.push(outcome);
    core.set(path, owners);
    // Dependencies of a narrow scope can still reach most of a large repository.
    if (core.size > CORE_SCOPE_FILE_LIMIT) return false;
    for (const dependency of await references(path)) roots.add(dependency);
  }
  return true;
}

/** Every changed file is a root of every required outcome, as in the scope-based selection. */
function changeCore(
  paths: readonly string[],
  outcomes: readonly { id: string }[],
  changed: ReadonlySet<string>,
) {
  const owners = outcomes.map((outcome) => outcome.id);
  return new Map<string, string[]>(
    paths
      .filter((path) => changed.has(path))
      .sort((a, b) => Number(productEntry(b)) - Number(productEntry(a)))
      .map((path) => [path, [...owners]]),
  );
}

/** One hop only: transitive imports of an existing module reach most of its repository. */
async function changeNeighbors(
  paths: readonly string[],
  changed: ReadonlySet<string>,
  references: (path: string) => Promise<string[]>,
) {
  const neighbors = new Set<string>();
  for (const path of paths.filter((entry) => changed.has(entry)))
    for (const dependency of await references(path))
      if (!changed.has(dependency)) neighbors.add(dependency);
  return [...neighbors].slice(0, NEIGHBOR_LIMIT);
}

function productEntry(path: string) {
  return /(?:^|\/)(?:index|main|cli|app)\.[^.]+$/.test(path);
}

function referenceReader(readSource: WorkspaceState["files"]["readTextIfExists"], paths: string[]) {
  const cache = new Map<string, string[]>();
  const aliases = new Map<string, string[]>();
  for (const path of paths)
    for (const alias of [path, path.replace(/\.[^./]+$/, ""), path.replace(/\/index\.[^./]+$/, "")])
      aliases.set(alias, [...(aliases.get(alias) ?? []), path]);
  return async (path: string) => {
    const cached = cache.get(path);
    if (cached) return cached;
    const read = await readSource(path);
    const selected = referencedApplicationPaths(path, read.ok ? (read.value ?? "") : "", aliases);
    cache.set(path, [...selected]);
    return [...selected];
  };
}

async function outcomeRoots(
  outcome: string,
  slices: readonly ProductSlice[],
  checks: readonly { check: ProductCheck; paths: string[] }[],
  paths: string[],
  references: (path: string) => Promise<string[]>,
  changed: ReadonlySet<string>,
) {
  const scope = slices
    .filter((entry) => entry.outcomes.includes(outcome))
    .flatMap((entry) => [...entry.scope.allowed, ...entry.scope.expected]);
  const inputs = checks.filter(({ check }) => check.outcomes.includes(outcome));
  const application = new Set(paths);
  const roots = new Set(paths.filter((path) => matchesAny(path, scope) || changed.has(path)));
  for (const { paths: checkPaths } of inputs) {
    for (const path of checkPaths) {
      // Past one review's worth of roots the selection is broad; stop reading.
      if (roots.size > CORE_SCOPE_FILE_LIMIT) return roots;
      for (const dependency of await references(path))
        if (application.has(dependency)) roots.add(dependency);
    }
  }
  return roots;
}

/** Resolve local imports and literal CLI/browser paths against observed, nonprivate source only. */
function referencedApplicationPaths(
  path: string,
  source: string,
  aliases: ReadonlyMap<string, string[]>,
) {
  const tokens = [
    ...[...source.matchAll(/["'`]([^"'`\s]+)["'`]/g)].map((match) => match[1] ?? ""),
    ...[...source.matchAll(/\b(?:from|import)\s+([\w.]+)/g)].map((match) =>
      (match[1] ?? "").replaceAll(".", "/"),
    ),
    ...(source.match(/[\w./-]+\.(?:py|[cm]?[jt]sx?|html?|css|sh)\b/g) ?? []),
  ];
  const selected = new Set<string>();
  for (const token of tokens) {
    const targets = [posix.normalize(token), posix.join(posix.dirname(path), token)].flatMap(
      (target) => [target, target.replace(/\.[cm]?[jt]sx?$/, "")],
    );
    for (const target of targets)
      for (const candidate of aliases.get(target) ?? []) selected.add(candidate);
  }
  return selected;
}
