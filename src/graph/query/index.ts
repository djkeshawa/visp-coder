import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { GraphStore } from "../store/index.js";
import type { GraphRevision } from "../store/store.js";
import type { GraphSnapshot } from "../types.js";
import { applyBudget, clampBudget, makeReceipt } from "./budget.js";
import { SnapshotIndex } from "./snapshot-index.js";
import { describe, entity, search, unknowns } from "./structure.js";
import { callees, callers, impact, neighbors, testsFor, tracePath } from "./traverse.js";
import type { QueryArgs, QueryBudget, QueryDraft, QueryEnvelope, QueryOperation } from "./types.js";

// Store mutation/close releases its revision key. Old snapshots are then collectible.
const INDEXES = new WeakMap<GraphRevision, SnapshotIndex>();
const RECENT_INDEXES = new Map<string, SnapshotIndex>();
const MAX_RECENT_INDEXES = 4;

/**
 * Ten bounded operations over a published snapshot. Each answer carries a
 * receipt: what was asked, under what budget, and whether the budget cut it.
 */

export function queryGraph(
  store: GraphStore,
  operation: QueryOperation,
  args: QueryArgs = {},
  requested?: Partial<QueryBudget>,
): Result<QueryEnvelope> {
  const index = getQueryIndex(store);
  return index.ok ? queryIndex(index.value, operation, args, requested) : index;
}

/** Shared indexed snapshot for query execution and unbounded exact symbol lookup. */
export function getQueryIndex(store: GraphStore): Result<SnapshotIndex> {
  const revision = store.readRevision();
  if (!revision.ok) return revision;
  const identity = store.readHeadIdentity();
  if (!identity.ok) return identity;
  if (!identity.value)
    return err(
      vispError("GRAPH_MISSING", "No graph snapshot has been published", {
        recovery: "visp index",
      }),
    );
  const key = `${store.cachePath}\0${identity.value}`;
  let index = INDEXES.get(revision.value);
  if (!index && store.cachePath !== ":memory:") index = RECENT_INDEXES.get(key);
  if (index) INDEXES.set(revision.value, index);
  if (!index) {
    const head = store.requireHead();
    if (!head.ok) return head;
    index = new SnapshotIndex(head.value);
    INDEXES.set(revision.value, index);
    if (store.cachePath !== ":memory:") {
      RECENT_INDEXES.delete(key);
      RECENT_INDEXES.set(key, index);
      if (RECENT_INDEXES.size > MAX_RECENT_INDEXES)
        RECENT_INDEXES.delete(RECENT_INDEXES.keys().next().value ?? "");
    }
  }
  return ok(index);
}

export function querySnapshot(
  snapshot: GraphSnapshot,
  operation: QueryOperation,
  args: QueryArgs = {},
  requested?: Partial<QueryBudget>,
): Result<QueryEnvelope> {
  // Public snapshots contain caller-owned arrays: never cache these by object identity.
  return queryIndex(new SnapshotIndex(snapshot), operation, args, requested);
}

/** File and parent-directory mtimes catch edits, deletions and newly added files. */
export async function queryFreshnessNote(
  store: GraphStore,
  root?: string,
): Promise<string | undefined> {
  const revision = store.readRevision();
  if (!revision.ok) return undefined;
  const snapshot = INDEXES.get(revision.value)?.snapshot;
  if (!snapshot) return undefined;
  if (root && snapshot.root !== root)
    return "Index belongs to another checkout; run visp index --refresh.";
  const created = Date.parse(snapshot.createdAt);
  if (!Number.isFinite(created)) return undefined;
  const paths = new Set<string>([snapshot.root]);
  for (const file of snapshot.files) {
    paths.add(join(snapshot.root, file.path));
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      paths.add(join(snapshot.root, ...parts.slice(0, index)));
    }
  }
  for (const path of paths) {
    try {
      const metadata = await lstat(path);
      if (metadata.mtimeMs > created)
        return "Index may be stale; run visp index --refresh before relying on absence.";
    } catch {
      return "Index may be stale; run visp index --refresh before relying on absence.";
    }
  }
  return undefined;
}

function queryIndex(
  index: SnapshotIndex,
  operation: QueryOperation,
  args: QueryArgs,
  requested?: Partial<QueryBudget>,
): Result<QueryEnvelope> {
  const budget = clampBudget(requested);

  const draft = run(index, operation, args, budget);
  if (!draft) {
    return err(vispError("UNSUPPORTED", `Unknown graph query operation: ${operation}`));
  }

  const budgeted = applyBudget(draft.rows, draft.unknowns, budget);
  const notes = budgeted.truncated
    ? [...draft.notes, "truncated by budget; unknowns were kept before rows"]
    : draft.notes;

  return ok(
    structuredClone({
      operation,
      rows: budgeted.rows,
      unknowns: budgeted.unknowns,
      receipt: makeReceipt(operation, budget, budgeted, index.snapshot, draft.work),
      notes,
      ...(draft.summary ? { summary: draft.summary } : {}),
    }),
  );
}

function run(
  index: SnapshotIndex,
  operation: QueryOperation,
  args: QueryArgs,
  budget: QueryBudget,
): QueryDraft | undefined {
  switch (operation) {
    case "describe":
      return describe(index);
    case "search":
      return search(index, args);
    case "entity":
      return entity(index, args);
    case "unknowns":
      return unknowns(index, args);
    case "neighbors":
      return neighbors(index, args, budget);
    case "callers":
      return callers(index, args, budget);
    case "callees":
      return callees(index, args, budget);
    case "impact":
      return impact(index, args, budget);
    case "testsFor":
      return testsFor(index, args, budget);
    case "tracePath":
      return tracePath(index, args, budget);
    default:
      return undefined;
  }
}

export { clampBudget } from "./budget.js";
export { SnapshotIndex } from "./snapshot-index.js";
export * from "./types.js";
