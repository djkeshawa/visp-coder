import { posix } from "node:path";
import { matchesAny } from "../../core/patterns.js";
import { privatePath } from "../../core/redaction.js";
import type { WorkspaceState } from "../state.js";
import type { ProductCheck, ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

/** Scope is deliberately conservative: lexical relevance cannot prove a file is nonessential. */
export async function coreReviewPaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  checks: readonly { check: ProductCheck; paths: string[] }[],
  slice?: ProductSlice,
  changed: ReadonlySet<string> = new Set(),
  readSource = workspace.files.readTextIfExists.bind(workspace.files),
) {
  const slices = slice ? [slice] : record.brief.slices;
  const paths = Object.keys(snapshot).filter((path) => !privatePath(path));
  const core = new Map<string, string[]>();
  const verifierEntries = new Set(checks.flatMap(({ paths }) => paths));
  const implementation = paths;
  const references = referenceReader(readSource, paths);
  const outcomes = record.brief.outcomes.filter(
    (entry) => entry.priority === "must" && (!slice || slice.outcomes.includes(entry.id)),
  );
  for (const outcome of outcomes) {
    const roots = await outcomeRoots(
      outcome.id,
      slices,
      checks,
      implementation,
      references,
      changed,
    );
    for (const path of roots) {
      const owners = core.get(path) ?? [];
      owners.push(outcome.id);
      core.set(path, owners);
      for (const dependency of await references(path)) roots.add(dependency);
    }
  }
  for (const path of implementation)
    if (
      !core.has(path) &&
      (changed.has(path) ||
        matchesAny(
          path,
          slices.flatMap((entry) => entry.scope.allowed),
        ))
    )
      core.set(path, []);
  return new Map(
    [...core].sort(
      ([a], [b]) =>
        Number(productEntry(b)) - Number(productEntry(a)) ||
        Number(changed.has(b)) - Number(changed.has(a)) ||
        Number(verifierEntries.has(a)) - Number(verifierEntries.has(b)),
    ),
  );
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
