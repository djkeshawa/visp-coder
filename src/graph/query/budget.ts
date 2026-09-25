import { LIMITS } from "../../core/constants.js";
import { hashValue } from "../../core/hash.js";
import type { UnknownRecord } from "../types.js";
import type { QueryBudget, QueryOperation, QueryReceipt, QueryRow, QueryWork } from "./types.js";

/** Budgets are clamped, never trusted: a caller cannot ask for an unbounded answer. */
export function clampBudget(requested?: Partial<QueryBudget>): Required<QueryBudget> {
  return {
    depth: clamp(requested?.depth ?? LIMITS.queryDepth, 1, LIMITS.maxQueryDepth),
    results: clamp(requested?.results ?? LIMITS.queryResults, 1, LIMITS.maxQueryResults),
    nodes: clamp(requested?.nodes ?? LIMITS.queryNodes, 1, LIMITS.maxQueryNodes),
    edges: clamp(requested?.edges ?? LIMITS.queryEdges, 1, LIMITS.maxQueryEdges),
  };
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

export interface BudgetedResult {
  readonly rows: QueryRow[];
  readonly unknowns: UnknownRecord[];
  readonly truncated: boolean;
}

/**
 * The unknown floor. When the budget cannot hold everything, result rows are
 * dropped before unknown records: an answer may be incomplete, but it must
 * never look complete.
 */
export function applyBudget(
  rows: readonly QueryRow[],
  unknowns: readonly UnknownRecord[],
  budget: QueryBudget,
): BudgetedResult {
  if (rows.length + unknowns.length <= budget.results) {
    return { rows: [...rows], unknowns: [...unknowns], truncated: false };
  }

  const floor = Math.min(unknowns.length, Math.max(1, Math.floor(budget.results / 2)));
  const keptRows = Math.min(rows.length, Math.max(0, budget.results - floor));
  const keptUnknowns = Math.min(unknowns.length, budget.results - keptRows);

  return {
    rows: rows.slice(0, keptRows),
    unknowns: unknowns.slice(0, keptUnknowns),
    truncated: keptRows < rows.length || keptUnknowns < unknowns.length,
  };
}

export function makeReceipt(
  operation: QueryOperation,
  budget: QueryBudget,
  result: BudgetedResult,
  work?: QueryWork,
): QueryReceipt {
  return {
    operation,
    budget,
    truncated: result.truncated || work?.truncated === true,
    ...(work ? { work } : {}),
    resultHash: hashValue({ rows: result.rows, unknowns: result.unknowns }),
  };
}
