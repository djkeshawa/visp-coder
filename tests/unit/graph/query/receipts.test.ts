import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../../../src/core/constants.js";
import { querySnapshot } from "../../../../src/graph/query/index.js";
import type { GraphSnapshot } from "../../../../src/graph/types.js";
import { type Fixture, indexFixture, makeRepo, TS_SOURCES } from "../fixtures.js";

let repo: Fixture;
let snapshot: GraphSnapshot;

beforeEach(async () => {
  repo = await makeRepo(TS_SOURCES);
  snapshot = await indexFixture(repo);
});

afterEach(async () => {
  await repo.cleanup();
});

describe("receipts", () => {
  it("records the operation and the budget actually used", () => {
    const answer = querySnapshot(snapshot, "search", { name: "a" }, { depth: 99, results: 99_999 });
    if (!answer.ok) throw new Error(answer.error.message);

    expect(answer.value.receipt.operation).toBe("search");
    expect(answer.value.receipt.budget).toEqual({
      depth: LIMITS.maxQueryDepth,
      results: LIMITS.maxQueryResults,
      nodes: LIMITS.queryNodes,
      edges: LIMITS.queryEdges,
    });
    expect(answer.value.receipt.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("marks truncation and keeps unknowns visible", () => {
    // Budget of one: known-global suppression thinned the fixture's unknowns
    // (deliberately), so the squeeze has to be this tight to still squeeze.
    const answer = querySnapshot(snapshot, "describe", {}, { results: 1 });
    if (!answer.ok) throw new Error(answer.error.message);

    expect(answer.value.receipt.truncated).toBe(true);
    expect(answer.value.unknowns.length).toBeGreaterThan(0);
    expect(answer.value.notes.join(" ")).toContain("truncated by budget");
    expect(answer.value.rows.length + answer.value.unknowns.length).toBeLessThanOrEqual(1);
  });

  it("produces byte-identical output for identical input", () => {
    const first = querySnapshot(snapshot, "neighbors", { path: "src/app.ts" }, { depth: 2 });
    const second = querySnapshot(snapshot, "neighbors", { path: "src/app.ts" }, { depth: 2 });
    if (!first.ok || !second.ok) throw new Error("expected both queries to succeed");

    expect(first.value.receipt.resultHash).toBe(second.value.receipt.resultHash);
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  it("refuses an operation it does not implement", () => {
    const answer = querySnapshot(
      snapshot,
      "nonsense" as Parameters<typeof querySnapshot>[1],
      {},
      {},
    );
    expect(answer.ok).toBe(false);
  });
});
