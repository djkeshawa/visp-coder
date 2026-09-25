import { describe, expect, it } from "vitest";
import { clampBudget } from "../../../../src/graph/query/budget.js";
import { querySnapshot } from "../../../../src/graph/query/index.js";
import type { QueryOperation } from "../../../../src/graph/query/types.js";
import type { GraphSnapshot, RelationKind } from "../../../../src/graph/types.js";

function star(count: number, kind: RelationKind = "calls"): GraphSnapshot {
  const entities = Array.from({ length: count + 1 }, (_, i) => ({
    id: `src/${i}.ts#file`,
    path: `src/${i}.ts`,
    kind: "file" as const,
    name: String(i),
    startLine: 1,
    endLine: 1,
  }));
  return {
    id: "work-probe",
    root: "/fixture",
    createdAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "fixture",
    schemaVersion: 1,
    files: [],
    entrypoints: [],
    languageCoverage: [],
    entities,
    relations: entities.slice(1).map((entity) => ({
      source: "src/0.ts#file",
      target: entity.id,
      kind,
      path: "src/0.ts",
      line: 1,
    })),
    unknowns: [{ kind: "dynamic_import", path: "src/0.ts", detail: "computed import" }],
  };
}

function ask(snapshot: GraphSnapshot, operation: QueryOperation, nodes: number, edges: number) {
  const result = querySnapshot(
    snapshot,
    operation,
    { entity: "src/0.ts#file", from: "src/0.ts#file", to: "src/100.ts#file" },
    { depth: 3, results: 5, nodes, edges },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("traversal work budgets", () => {
  it("caps a large fanout independently of returned rows and preserves unknowns", () => {
    const snapshot = star(20_000);
    const answer = ask(snapshot, "neighbors", 12, 100);
    expect(answer.receipt.work).toEqual({ visitedNodes: 12, examinedEdges: 12, truncated: true });
    expect(answer.rows.length + answer.unknowns.length).toBe(5);
    expect(answer.unknowns).toEqual(snapshot.unknowns);
    expect(answer.receipt.truncated).toBe(true);
    expect(answer.notes.join(" ")).toContain("unknowns are incomplete");
    expect(ask(snapshot, "neighbors", 12, 100)).toEqual(answer);
  });

  it.each(["callers", "callees", "impact", "testsFor", "tracePath"] as const)(
    "bounds %s including edges rejected by filters",
    (operation) => {
      const original = star(100, "exports");
      const snapshot =
        operation === "callers" || operation === "impact"
          ? {
              ...original,
              relations: original.relations.map((r) => ({
                ...r,
                source: r.target,
                target: r.source,
              })),
            }
          : original;
      const answer = ask(snapshot, operation, 200, 7);
      expect(answer.receipt.work?.examinedEdges).toBe(7);
      expect(answer.receipt.work?.truncated).toBe(true);
      expect(answer.notes.join(" ")).not.toMatch(/no path|no test file|nothing within/);
    },
  );

  it("terminates cycles without exhausting a sufficient budget", () => {
    const original = star(1);
    const snapshot = {
      ...original,
      relations: [
        ...original.relations,
        {
          source: "src/1.ts#file",
          target: "src/0.ts#file",
          kind: "calls" as const,
          path: "src/1.ts",
          line: 1,
        },
      ],
    };
    const answer = ask(snapshot, "neighbors", 2, 4);
    expect(answer.receipt.work).toEqual({ visitedNodes: 2, examinedEdges: 4, truncated: false });
    expect(answer.rows).toHaveLength(1);
  });

  it("finds a path with sufficient work and does not claim absence after an early stop", () => {
    const snapshot = star(100);
    expect(ask(snapshot, "tracePath", 200, 200).rows.map((row) => row.name)).toEqual(["0", "100"]);
    const limited = ask(snapshot, "tracePath", 2, 200);
    expect(limited.rows).toEqual([]);
    expect(limited.receipt.truncated).toBe(true);
    expect(limited.notes.join(" ")).toContain("incomplete");
  });

  it("clamps unsafe work limits", () => {
    expect(clampBudget({ nodes: Number.NaN, edges: 0 })).toMatchObject({ nodes: 1, edges: 1 });
    expect(clampBudget({ nodes: 1e9, edges: 1e9 })).toMatchObject({ nodes: 20_000, edges: 80_000 });
  });
});
