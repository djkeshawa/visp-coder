import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStore } from "../../../../src/graph/store/index.js";
import type { GraphStore } from "../../../../src/graph/store/store.js";
import type { Entity, SnapshotInput } from "../../../../src/graph/types.js";
import { type Fixture, makeRepo } from "../fixtures.js";

let repo: Fixture;
let store: GraphStore;

beforeEach(async () => {
  repo = await makeRepo();
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await repo.cleanup();
});

function snapshot(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    root: repo.root,
    createdAt: "2026-01-01T00:00:00.000Z",
    fingerprint: "fingerprint-one",
    files: [{ path: "src/a.ts", bytes: 12, hash: "a".repeat(64), language: "typescript" }],
    entities: [
      {
        id: "src/a.ts#file",
        path: "src/a.ts",
        kind: "file",
        name: "a.ts",
        startLine: 1,
        endLine: 3,
      },
    ],
    relations: [
      {
        source: "src/a.ts#file",
        target: "external:zod",
        kind: "external",
        path: "src/a.ts",
        line: 1,
      },
    ],
    unknowns: [{ kind: "unresolved_call", path: "src/a.ts", detail: "mystery" }],
    entrypoints: [
      { kind: "package_script", path: "package.json", name: "build", line: 4, evidence: '"build"' },
    ],
    languageCoverage: [{ language: "typescript", totalFiles: 1, parsedFiles: 1 }],
    ...overrides,
  };
}

describe("snapshot round trip", () => {
  it("returns everything that was published", async () => {
    const published = store.publishSnapshot(snapshot());
    if (!published.ok) throw new Error(published.error.message);
    expect(store.readHeadId()).toEqual({ ok: true, value: published.value.id });

    const head = store.readHead();
    if (!head.ok || !head.value) throw new Error("expected a head snapshot");

    expect(head.value.files).toEqual(snapshot().files);
    expect(head.value.entities).toEqual(snapshot().entities);
    expect(head.value.relations).toEqual(snapshot().relations);
    expect(head.value.unknowns).toEqual(snapshot().unknowns);
    expect(head.value.entrypoints).toEqual(snapshot().entrypoints);
    expect(head.value.languageCoverage).toEqual(snapshot().languageCoverage);
  });

  it("reports a missing graph rather than an empty one", () => {
    expect(store.readHeadId()).toEqual({ ok: true, value: undefined });
    const head = store.readHead();
    expect(head.ok && head.value).toBeUndefined();
    expect(store.requireHead().ok).toBe(false);
  });

  it("exposes per-file hashes for incremental reuse", () => {
    store.publishSnapshot(snapshot());
    const hashes = store.readFileHashes();
    expect(hashes.ok && hashes.value.get("src/a.ts")).toBe("a".repeat(64));
  });
});

describe("head pointer", () => {
  it("reads the head and all rows from one database version during concurrent replacement", () => {
    const original = snapshot({ id: "old-head" });
    expect(store.publishSnapshot(original).ok).toBe(true);
    const connected = openStore(repo.storePath);
    if (!connected.ok) throw new Error(connected.error.message);
    const other = connected.value;
    const readId = store.readHeadId.bind(store);
    vi.spyOn(store, "readHeadId").mockImplementationOnce(() => {
      const pointer = readId();
      expect(
        other.publishSnapshot(
          snapshot({ id: "new-head", fingerprint: "new", files: [], entities: [] }),
        ).ok,
      ).toBe(true);
      return pointer;
    });
    try {
      const current = store.requireHead();
      if (!current.ok) throw new Error(current.error.message);
      expect(current.value.fingerprint).toBe(original.fingerprint);
      expect(current.value.files).toEqual(original.files);
      expect(current.value.entities).toEqual(original.entities);
      const next = store.requireHead();
      expect(next.ok && next.value.fingerprint).toBe("new");
    } finally {
      other.close();
    }
  });

  it("does not mix metadata, files, and entities across a same-ID replacement", () => {
    const original = snapshot({ id: "same-id" });
    expect(store.publishSnapshot(original).ok).toBe(true);
    const connected = openStore(repo.storePath);
    if (!connected.ok) throw new Error(connected.error.message);
    const other = connected.value;
    const reader = store as unknown as {
      select: (table: string, id: string, order: string) => unknown[];
    };
    const select = reader.select.bind(store);
    // Inject the competing commit between two synchronous SQLite selects.
    vi.spyOn(reader, "select").mockImplementation((table, id, order) => {
      const rows = select(table, id, order);
      if (table === "files") {
        expect(
          other.publishSnapshot(
            snapshot({ id: "same-id", fingerprint: "new", files: [], entities: [] }),
          ).ok,
        ).toBe(true);
      }
      return rows;
    });
    try {
      const read = store.readSnapshot("same-id");
      if (!read.ok || !read.value) throw new Error("Expected original snapshot");
      expect(read.value.fingerprint).toBe(original.fingerprint);
      expect(read.value.files).toEqual(original.files);
      expect(read.value.entities).toEqual(original.entities);
    } finally {
      other.close();
    }
  });

  it("moves only after a complete write", () => {
    const first = store.publishSnapshot(snapshot());
    expect(first.ok).toBe(true);

    const corrupt = {
      id: "corrupt-snapshot",
      path: "src/a.ts",
      kind: "file",
      name: "a.ts",
      startLine: "not-a-line",
      endLine: 3,
    } as unknown as Entity;

    const second = store.publishSnapshot(
      snapshot({
        fingerprint: "fingerprint-two",
        createdAt: "2026-01-02T00:00:00.000Z",
        entities: [corrupt],
      }),
    );

    expect(second.ok).toBe(false);
    const head = store.readHead();
    expect(head.ok && head.value?.fingerprint).toBe("fingerprint-one");
    expect(head.ok && head.value?.entities).toEqual(snapshot().entities);
  });

  it("advances to a newer complete snapshot", () => {
    store.publishSnapshot(snapshot());
    const next = store.publishSnapshot(
      snapshot({ fingerprint: "fingerprint-two", createdAt: "2026-01-03T00:00:00.000Z" }),
    );

    expect(next.ok).toBe(true);
    const head = store.readHead();
    expect(head.ok && head.value?.fingerprint).toBe("fingerprint-two");
  });
});

describe("deleteRepository", () => {
  it("removes the head and every snapshot row", () => {
    store.publishSnapshot(snapshot());
    expect(store.deleteRepository().ok).toBe(true);

    const head = store.readHead();
    expect(head.ok && head.value).toBeUndefined();
  });
});
