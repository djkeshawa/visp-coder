import {
  checkCurrency,
  type GraphSnapshot,
  isIndexableProjectPath,
  type QueryRow,
  queryGraph,
} from "../../graph/index.js";

import type { WorkspaceState } from "../state.js";

const MAX_CONTEXT_PATHS = 4;

/** Both context and skill selection require facts from this checkout's current inputs. */
export async function productGraphCurrencyGap(
  workspace: WorkspaceState,
  snapshot: GraphSnapshot,
): Promise<string | undefined> {
  if (snapshot.root !== workspace.paths.root) return "index belongs to another checkout";
  const currency = await checkCurrency(workspace.paths.root, snapshot, workspace.config.graph);
  if (!currency.ok) return currency.error.message;
  if (currency.value.state !== "current") return `index is ${currency.value.state}`;
  return undefined;
}

export async function queryCurrentProductPaths(
  workspace: WorkspaceState,
  store: Parameters<typeof queryGraph>[0],
  paths: readonly string[],
  question?: string,
): Promise<{ graph: QueryRow[]; notes: string[] }> {
  const head = store.requireHead();
  const gap = head.ok ? await productGraphCurrencyGap(workspace, head.value) : head.error.message;
  if (gap)
    return {
      graph: [],
      notes: [`Graph unavailable: ${gap}. Refresh through visp work; inspect source directly.`],
    };
  return queryProductPaths(store, paths, question);
}

/** Follow named symbols in a concrete failure before falling back to file neighborhoods. */
export function queryProductPaths(
  store: Parameters<typeof queryGraph>[0],
  paths: readonly string[],
  question?: string,
) {
  const rows = new Map<string, QueryRow>();
  const notes = new Set<string>();
  const add = (result: ReturnType<typeof queryGraph>) => {
    if (!result.ok) {
      notes.add(result.error.message);
      return;
    }
    for (const row of result.value.rows) rows.set(`${row.kind}:${row.key}`, row);
    for (const unknown of result.value.unknowns.slice(0, 4))
      notes.add(`Graph uncertainty: ${unknown.detail}`);
    if (result.value.receipt.truncated)
      notes.add("Graph context is partial; use a targeted query for additional callers or tests.");
  };
  const eligible = paths.filter(isIndexableProjectPath);
  const focused = focusPaths(store, eligible, question);
  if (eligible.length > MAX_CONTEXT_PATHS)
    notes.add(
      `Graph focus covers ${MAX_CONTEXT_PATHS} of ${eligible.length} declared source files; named targets take priority. Query additional affected paths when needed.`,
    );
  for (const path of focused) {
    const found = question ? queryGraph(store, "search", { path }, { results: 200 }) : undefined;
    const named = found?.ok
      ? found.value.rows
          .filter((row) => {
            const escaped = row.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(question ?? "");
          })
          .slice(0, 2)
      : [];
    if (!named.length) {
      add(queryGraph(store, "testsFor", { path }, { depth: 1, results: 12 }));
      add(queryGraph(store, "neighbors", { path }, { depth: 1, results: 12 }));
      continue;
    }
    for (const symbol of named) {
      rows.set(`${symbol.kind}:${symbol.key}`, symbol);
      for (const operation of ["testsFor", "callers", "callees"] as const)
        add(queryGraph(store, operation, { entity: symbol.key }, { depth: 1, results: 12 }));
    }
  }
  return { graph: [...rows.values()], notes: [...notes] };
}

/** Rank only declared roots; related read-only callers never become editing authority. */
function focusPaths(
  store: Parameters<typeof queryGraph>[0],
  paths: readonly string[],
  question = "",
): string[] {
  if (paths.length <= MAX_CONTEXT_PATHS || !question) return paths.slice(0, MAX_CONTEXT_PATHS);
  const terms = new Set(question.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const scores = new Map(paths.map((path) => [path, question.includes(path) ? 2 : 0]));
  const snapshot = store.requireHead();
  if (snapshot.ok)
    for (const entity of snapshot.value.entities)
      if (entity.kind !== "file" && scores.has(entity.path) && terms.has(entity.name))
        scores.set(entity.path, Math.max(scores.get(entity.path) ?? 0, 1));
  return [...paths]
    .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
    .slice(0, MAX_CONTEXT_PATHS);
}
