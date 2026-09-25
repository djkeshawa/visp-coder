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
  const revision = store.readRevision();
  if (!revision.ok) return revision;
  let index = INDEXES.get(revision.value);
  if (!index) {
    const head = store.requireHead();
    if (!head.ok) return head;
    index = new SnapshotIndex(head.value);
    INDEXES.set(revision.value, index);
  }
  return queryIndex(index, operation, args, requested);
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
      receipt: makeReceipt(operation, budget, budgeted, draft.work),
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
