import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/config/load.js";
import { ProjectFileSystem } from "../../../src/core/fs.js";
import { checkCurrency } from "../../../src/graph/currency.js";
import { indexRepository, refreshRepository } from "../../../src/graph/refresh.js";
import { openProjectStore, openStore } from "../../../src/graph/store/index.js";
import type { GraphSnapshot } from "../../../src/graph/types.js";
import { type Fixture, graphConfig, makeRepo } from "./fixtures.js";

let repo: Fixture;
afterEach(async () => {
  await repo?.cleanup();
});

function head(): GraphSnapshot {
  const opened = openStore(repo.storePath);
  if (!opened.ok) throw new Error(opened.error.message);
  try {
    const result = opened.value.requireHead();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  } finally {
    opened.value.close();
  }
}

describe("extraction configuration identity", () => {
  it("applies authored language, exclude and byte limits across indexing and refresh", async () => {
    repo = await makeRepo({
      "app.ts": "export const value = 1;\n",
      "app.py": "def useful():\n    return 1\n",
      "docs/skip.ts": "export const skipped = 1;\n",
      "large.ts": `export const large = 1;\n${" ".repeat(600)}`,
    });
    const authored = (graph: string) => {
      const loaded = parseConfig(`graph:\n${graph}`, "visp.yml");
      if (!loaded.ok) throw new Error(loaded.error.message);
      return loaded.value.graph;
    };
    const narrow = authored(
      "  languages: [typescript]\n  exclude: [docs/**]\n  maxFileBytes: 128\n",
    );
    const indexed = await indexRepository(repo.root, narrow, repo.storePath);
    expect(indexed.ok).toBe(true);
    const before = head();
    expect(
      before.entities.some((entity) => entity.path === "app.ts" && entity.name === "value"),
    ).toBe(true);
    expect(before.entities.some((entity) => entity.path === "app.py")).toBe(false);
    expect(before.entities.some((entity) => entity.path === "docs/skip.ts")).toBe(false);
    expect(before.unknowns).toContainEqual({
      kind: "file_skipped",
      path: "large.ts",
      detail: "too_large",
    });

    const broad = authored(
      "  languages: [typescript, python]\n  exclude: []\n  maxFileBytes: 1024\n",
    );
    const currency = await checkCurrency(repo.root, before, broad);
    expect(currency.ok && currency.value.state).toBe("divergent");
    const refreshed = await refreshRepository(repo.root, broad, repo.storePath);
    expect(refreshed.ok && refreshed.value.noChange).toBe(false);
    const after = head();
    for (const [path, name] of [
      ["app.py", "useful"],
      ["docs/skip.ts", "skipped"],
      ["large.ts", "large"],
    ]) {
      expect(after.entities.some((entity) => entity.path === path && entity.name === name)).toBe(
        true,
      );
    }
    expect(after.unknowns).not.toContainEqual({
      kind: "file_skipped",
      path: "large.ts",
      detail: "too_large",
    });
  });

  it("reparses unchanged files when a language is enabled and matches a full index", async () => {
    repo = await makeRepo({ "app.ts": "export const value = 1;" });
    expect(
      (await indexRepository(repo.root, graphConfig({ languages: [] }), repo.storePath)).ok,
    ).toBe(true);
    const before = head();
    expect(before.entities).toEqual([]);
    const currency = await checkCurrency(repo.root, before, graphConfig());
    expect(currency.ok && currency.value.state).toBe("divergent");
    const refreshed = await refreshRepository(repo.root, graphConfig(), repo.storePath);
    expect(refreshed.ok && refreshed.value.filesParsed).toBe(1);
    const incremental = head();
    await indexRepository(repo.root, graphConfig(), repo.storePath);
    expect(incremental.entities).toEqual(head().entities);
    expect(incremental.entities.length).toBeGreaterThan(0);
  });

  it("refreshes aliases when an excluded inherited configuration changes or is created", async () => {
    repo = await makeRepo({
      "tsconfig.json": '{"extends":"./config/child.json"}',
      "config/child.json": '{"extends":"../shared.json"}',
      "app.ts": 'import { value } from "@target"; export const result = value;',
      "old.ts": "export const value = 1;",
      "new.ts": "export const value = 2;",
    });
    const config = graphConfig({ exclude: ["**/*.json"] });
    await indexRepository(repo.root, config, repo.storePath);
    const before = head();
    await repo.write("shared.json", '{"compilerOptions":{"paths":{"@target":["old.ts"]}}}');
    const currency = await checkCurrency(repo.root, before, config);
    expect(currency.ok && currency.value).toMatchObject({
      state: "divergent",
      counts: { added: 0, changed: 0, deleted: 0 },
    });
    await refreshRepository(repo.root, config, repo.storePath);
    expect(head().relations.some((relation) => relation.target === "old.ts#file")).toBe(true);

    await repo.write("shared.json", '{"compilerOptions":{"paths":{"@target":["new.ts"]}}}');
    const refreshed = await refreshRepository(repo.root, config, repo.storePath);
    expect(refreshed.ok && refreshed.value.noChange).toBe(false);
    const incremental = head();
    await indexRepository(repo.root, config, repo.storePath);
    expect(incremental.relations).toEqual(head().relations);
    expect(incremental.relations.some((relation) => relation.target === "new.ts#file")).toBe(true);
    expect(incremental.relations.some((relation) => relation.target === "old.ts#file")).toBe(false);
  });

  it("does not reparse for retired budget fields in a historical graph configuration object", async () => {
    repo = await makeRepo({ "app.ts": "export const value = 1;" });
    await indexRepository(repo.root, graphConfig(), repo.storePath);
    const changed = { ...graphConfig(), queryDepth: 1, queryResults: 1 };
    const currency = await checkCurrency(repo.root, head(), changed);
    expect(currency.ok && currency.value.state).toBe("current");
    const refreshed = await refreshRepository(repo.root, changed, repo.storePath);
    expect(refreshed.ok && refreshed.value).toMatchObject({ noChange: true, filesParsed: 0 });
  });

  it("reads a legacy database without migration and upgrades it only on writable refresh", async () => {
    repo = await makeRepo({ "app.ts": "export const value = 1;" });
    await indexRepository(repo.root, graphConfig(), repo.storePath);
    const db = new DatabaseSync(repo.storePath);
    db.exec("ALTER TABLE snapshots DROP COLUMN extraction_fingerprint");
    db.exec("UPDATE snapshots SET schema_version = 1");
    db.close();

    const readonly = await openProjectStore(new ProjectFileSystem(repo.root), repo.storePath, {
      writable: false,
    });
    if (!readonly.ok) throw new Error(readonly.error.message);
    const snapshot = readonly.value.requireHead();
    readonly.value.close();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(snapshot.value.extractionFingerprint).toBeUndefined();
    expect((await checkCurrency(repo.root, snapshot.value, graphConfig())).ok).toBe(true);
    const inspect = new DatabaseSync(repo.storePath, { readOnly: true });
    expect(
      inspect
        .prepare("PRAGMA table_info(snapshots)")
        .all()
        .some((column) => column.name === "extraction_fingerprint"),
    ).toBe(false);
    inspect.close();

    const refreshed = await refreshRepository(repo.root, graphConfig(), repo.storePath);
    expect(refreshed.ok && refreshed.value.filesParsed).toBe(1);
    expect(head()).toMatchObject({
      schemaVersion: 2,
      extractionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await refreshRepository(repo.root, graphConfig(), repo.storePath)).ok).toBe(true);
  });
});
