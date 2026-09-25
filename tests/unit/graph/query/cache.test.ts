import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryGraph, querySnapshot } from "../../../../src/graph/query/index.js";
import type { QueryEnvelope } from "../../../../src/graph/query/types.js";
import { openStore } from "../../../../src/graph/store/index.js";
import type { GraphStore } from "../../../../src/graph/store/store.js";
import type { GraphSnapshot, SnapshotInput } from "../../../../src/graph/types.js";
import { type Fixture, makeRepo } from "../fixtures.js";

let repo: Fixture;
let store: GraphStore;

function snapshot(name = "before"): SnapshotInput {
  return {
    id: "stable-head",
    root: repo.root,
    createdAt: "2026-01-01T00:00:00.000Z",
    fingerprint: name,
    files: [{ path: "a.ts", bytes: 1, hash: name, language: "typescript" }],
    entities: [
      { id: "a.ts#function:test", path: "a.ts", kind: "function", name, startLine: 1, endLine: 2 },
    ],
    relations: [],
    unknowns: [{ kind: "unresolved_call", path: "a.ts", detail: "unresolved source" }],
    entrypoints: [],
    languageCoverage: [{ language: "typescript", totalFiles: 1, parsedFiles: 1 }],
  };
}

function ask(operation: "search" | "describe" | "unknowns" = "search"): QueryEnvelope {
  const result = queryGraph(store, operation, { path: "a.ts" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  repo = await makeRepo();
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  expect(store.publishSnapshot(snapshot()).ok).toBe(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await repo.cleanup();
});

describe("graph query index reuse", () => {
  it("loads snapshot rows once for unchanged repeated queries", () => {
    const read = vi.spyOn(store, "requireHead");
    const first = ask();
    expect(ask()).toEqual(first);
    expect(ask("describe").summary?.files).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("invalidates a locally republished snapshot even when the head ID is unchanged", () => {
    expect(ask().rows[0]?.name).toBe("before");
    expect(store.publishSnapshot(snapshot("after")).ok).toBe(true);
    expect(ask().rows[0]?.name).toBe("after");
  });

  it("invalidates replacement and deletion from another SQLite connection", () => {
    expect(ask().rows[0]?.name).toBe("before");
    const opened = openStore(repo.storePath);
    if (!opened.ok) throw new Error(opened.error.message);
    const other = opened.value;
    try {
      expect(other.publishSnapshot(snapshot("external")).ok).toBe(true);
      expect(ask().rows[0]?.name).toBe("external");
      expect(other.deleteRepository().ok).toBe(true);
      const missing = queryGraph(store, "describe");
      expect(!missing.ok && missing.error.code).toBe("GRAPH_MISSING");
    } finally {
      other.close();
    }
  });

  it("returns errors after local deletion or closing instead of a cached graph", () => {
    ask();
    expect(store.deleteRepository().ok).toBe(true);
    expect(queryGraph(store, "describe").ok).toBe(false);
    expect(store.publishSnapshot(snapshot()).ok).toBe(true);
    ask();
    store.close();
    expect(queryGraph(store, "describe").ok).toBe(false);
  });

  it("does not let returned unknowns and summary arrays mutate cached facts", () => {
    const first = ask("describe");
    const expected = structuredClone(first);
    if (!first.unknowns[0] || !first.summary?.languageCoverage[0])
      throw new Error("Missing fixture data");
    Object.assign(first.unknowns[0], { detail: "consumer mutation" });
    Object.assign(first.summary.languageCoverage[0], { parsedFiles: 999 });
    first.summary.languageCoverage.push({ language: "python", totalFiles: 12, parsedFiles: 12 });
    expect(ask("describe")).toEqual(expected);
  });

  it("keeps caller-owned querySnapshot arrays fresh between calls", () => {
    const published = store.requireHead();
    if (!published.ok) throw new Error(published.error.message);
    const mutable: GraphSnapshot = published.value;
    expect(querySnapshot(mutable, "search", { path: "a.ts" }).ok).toBe(true);
    mutable.entities.splice(0, mutable.entities.length);
    const changed = querySnapshot(mutable, "search", { path: "a.ts" });
    expect(changed.ok && changed.value.rows).toEqual([]);
  });
});
