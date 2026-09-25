import { describe, expect, it } from "vitest";
import { LIMITS } from "../../../../src/core/constants.js";
import { applyBudget, clampBudget } from "../../../../src/graph/query/budget.js";
import type { QueryRow } from "../../../../src/graph/query/types.js";
import type { UnknownRecord } from "../../../../src/graph/types.js";

function rows(count: number): QueryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "entity" as const,
    key: `entity-${index}`,
    path: `src/${index}.ts`,
    name: `n${index}`,
    detail: "function",
  }));
}

function unknowns(count: number): UnknownRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "unresolved_call" as const,
    path: `src/${index}.ts`,
    detail: `call-${index}`,
  }));
}

describe("clampBudget", () => {
  it("uses built-in defaults when nothing is asked for", () => {
    expect(clampBudget()).toEqual({
      depth: LIMITS.queryDepth,
      results: LIMITS.queryResults,
      nodes: LIMITS.queryNodes,
      edges: LIMITS.queryEdges,
    });
  });

  it("clamps an over-large request to the hard maximum", () => {
    expect(clampBudget({ depth: 9_999, results: 9_999 })).toEqual({
      depth: LIMITS.maxQueryDepth,
      results: LIMITS.maxQueryResults,
      nodes: LIMITS.queryNodes,
      edges: LIMITS.queryEdges,
    });
  });

  it("refuses a zero or nonsense budget", () => {
    expect(clampBudget({ depth: 0, results: -5 })).toEqual({
      depth: 1,
      results: 1,
      nodes: LIMITS.queryNodes,
      edges: LIMITS.queryEdges,
    });
    expect(clampBudget({ depth: Number.NaN, results: Number.NaN })).toEqual({
      depth: 1,
      results: 1,
      nodes: LIMITS.queryNodes,
      edges: LIMITS.queryEdges,
    });
  });
});

describe("applyBudget", () => {
  it("keeps everything when it fits", () => {
    const result = applyBudget(rows(3), unknowns(2), { depth: 3, results: 10 });
    expect(result.truncated).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.unknowns).toHaveLength(2);
  });

  it("drops rows before unknowns and marks the truncation", () => {
    const result = applyBudget(rows(50), unknowns(4), { depth: 3, results: 10 });

    expect(result.truncated).toBe(true);
    expect(result.unknowns).toHaveLength(4);
    expect(result.rows).toHaveLength(6);
  });

  it("keeps at least one unknown even under a budget of one", () => {
    const result = applyBudget(rows(50), unknowns(9), { depth: 3, results: 1 });

    expect(result.rows).toHaveLength(0);
    expect(result.unknowns).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("gives unused row space back to unknowns", () => {
    const result = applyBudget(rows(2), unknowns(50), { depth: 3, results: 10 });

    expect(result.rows).toHaveLength(2);
    expect(result.unknowns).toHaveLength(8);
    expect(result.truncated).toBe(true);
  });
});
