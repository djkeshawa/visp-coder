import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCurrency } from "../../../src/graph/currency.js";
import { parseCount, resetParseCount } from "../../../src/graph/extract/parser.js";
import { indexRepository, refreshRepository } from "../../../src/graph/refresh.js";
import { openStore } from "../../../src/graph/store/index.js";
import type { GraphSnapshot } from "../../../src/graph/types.js";
import { type Fixture, graphConfig, makeRepo, TS_SOURCES } from "./fixtures.js";

let repo: Fixture;

beforeEach(async () => {
  repo = await makeRepo(TS_SOURCES);
});

afterEach(async () => {
  await repo.cleanup();
});

async function index() {
  const result = await indexRepository(repo.root, graphConfig(), repo.storePath);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function refresh() {
  const result = await refreshRepository(repo.root, graphConfig(), repo.storePath);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function head(): GraphSnapshot {
  const store = openStore(repo.storePath);
  if (!store.ok) throw new Error(store.error.message);
  try {
    const snapshot = store.value.requireHead();
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    return snapshot.value;
  } finally {
    store.value.close();
  }
}

describe("indexRepository", () => {
  it("publishes a snapshot covering every walked file", async () => {
    const report = await index();
    expect(report.counts.files).toBe(Object.keys(TS_SOURCES).length);
    expect(report.filesParsed).toBe(Object.keys(TS_SOURCES).length);
    expect(head().entities.length).toBeGreaterThan(0);
  });
});

describe("refreshRepository", () => {
  it("parses nothing when no file changed, and says so", async () => {
    await index();
    resetParseCount();

    const report = await refresh();

    expect(report.noChange).toBe(true);
    expect(report.filesParsed).toBe(0);
    expect(parseCount()).toBe(0);
    expect(report.diff.unchanged).toHaveLength(Object.keys(TS_SOURCES).length);
  });

  it("re-parses only the changed file", async () => {
    await index();
    await repo.write(
      "src/app.ts",
      'import { add } from "./math.js";\nexport const run = () => add(1, 1);\n',
    );
    resetParseCount();

    const report = await refresh();

    expect(report.diff.changed).toEqual(["src/app.ts"]);
    expect(report.filesParsed).toBe(1);
    expect(parseCount()).toBe(1);
    expect(report.filesReused).toBe(Object.keys(TS_SOURCES).length - 1);
  });

  it("keeps facts about files that did not change", async () => {
    await index();
    await repo.write("src/app.ts", "export const run = () => 0;\n");
    await refresh();

    const entities = head().entities.filter((entity) => entity.path === "src/math.ts");
    expect(entities.map((entity) => entity.name)).toContain("Calculator");
  });

  it("invalidates relations that pointed at a deleted file", async () => {
    await index();
    expect(head().relations.some((relation) => relation.target === "src/math.ts#file")).toBe(true);

    await repo.remove("src/math.ts");
    const report = await refresh();

    expect(report.diff.deleted).toEqual(["src/math.ts"]);
    const after = head();
    expect(after.entities.some((entity) => entity.path === "src/math.ts")).toBe(false);
    expect(after.relations.some((relation) => relation.target === "src/math.ts#file")).toBe(false);
    expect(after.unknowns.some((record) => record.kind === "unresolved_import")).toBe(true);
  });

  it("matches a full index when a new export travels through a barrel to its importer", async () => {
    await repo.write("src/leaf.ts", "export const existing = 1;\n");
    await repo.write("src/barrel.ts", 'export { fresh } from "./leaf.js";\n');
    await repo.write(
      "src/consumer.ts",
      [
        'import { fresh } from "./barrel.js";',
        "",
        "export function consume(): number {",
        "  return fresh();",
        "}",
        "",
      ].join("\n"),
    );
    await repo.write("src/unrelated.ts", "export const untouched = 1;\n");
    await index();

    await repo.write("src/leaf.ts", "export function fresh(): number {\n  return 1;\n}\n");
    resetParseCount();
    const report = await refresh();
    const parsed = parseCount();
    const refreshed = head();

    await index();
    const full = head();

    expect({
      files: refreshed.files,
      entities: refreshed.entities,
      relations: refreshed.relations,
      unknowns: refreshed.unknowns,
      entrypoints: refreshed.entrypoints,
      languageCoverage: refreshed.languageCoverage,
    }).toEqual({
      files: full.files,
      entities: full.entities,
      relations: full.relations,
      unknowns: full.unknowns,
      entrypoints: full.entrypoints,
      languageCoverage: full.languageCoverage,
    });
    expect(report.filesParsed).toBe(3);
    expect(parsed).toBe(3);
  });

  it("matches a full index when a deleted export travels through a barrel to its importer", async () => {
    await repo.write("src/leaf.ts", "export function fresh(): number {\n  return 1;\n}\n");
    await repo.write("src/barrel.ts", 'export { fresh } from "./leaf.js";\n');
    await repo.write(
      "src/consumer.ts",
      'import { fresh } from "./barrel.js";\nexport const consume = () => fresh();\n',
    );
    await repo.write("src/unrelated.ts", "export const untouched = 1;\n");
    await repo.write(
      "src/unrelated-chain.ts",
      'import { untouched } from "./unrelated.js";\nexport const stillUntouched = untouched;\n',
    );
    await index();

    await repo.remove("src/leaf.ts");
    resetParseCount();
    const report = await refresh();
    const parsed = parseCount();
    const refreshed = head();

    await index();
    const full = head();

    expect(graphFacts(refreshed)).toEqual(graphFacts(full));
    expect(report.diff.deleted).toEqual(["src/leaf.ts"]);
    expect(report.filesParsed).toBe(2);
    expect(parsed).toBe(2);
  });

  it("matches a full index when an added export satisfies an unresolved barrel import", async () => {
    await repo.write("src/barrel.ts", 'export { fresh } from "./missing.js";\n');
    await repo.write(
      "src/consumer.ts",
      'import { fresh } from "./barrel.js";\nexport const consume = () => fresh();\n',
    );
    await repo.write("src/unrelated.ts", "export const untouched = 1;\n");
    await repo.write(
      "src/unrelated-chain.ts",
      'import { untouched } from "./unrelated.js";\nexport const stillUntouched = untouched;\n',
    );
    await index();

    await repo.write("src/missing.ts", "export function fresh(): number {\n  return 1;\n}\n");
    resetParseCount();
    const report = await refresh();
    const parsed = parseCount();
    const refreshed = head();

    await index();
    const full = head();

    expect(graphFacts(refreshed)).toEqual(graphFacts(full));
    expect(report.diff.added).toEqual(["src/missing.ts"]);
    expect(report.filesParsed).toBe(3);
    expect(parsed).toBe(3);
  });
});

function graphFacts(snapshot: GraphSnapshot) {
  return {
    files: snapshot.files,
    entities: snapshot.entities,
    relations: snapshot.relations,
    unknowns: snapshot.unknowns,
    entrypoints: snapshot.entrypoints,
    languageCoverage: snapshot.languageCoverage,
  };
}

describe("checkCurrency", () => {
  it("calls an untouched worktree current", async () => {
    await index();
    const report = await checkCurrency(repo.root, head(), graphConfig());

    expect(report.ok && report.value.state).toBe("current");
  });

  it("calls a modified worktree divergent and names the paths", async () => {
    await index();
    const snapshot = head();
    await repo.write("src/new.ts", "export const fresh = 1;\n");
    await repo.write("src/app.ts", "export const run = () => 1;\n");
    await repo.remove("src/math.ts");

    const report = await checkCurrency(repo.root, snapshot, graphConfig());
    if (!report.ok) throw new Error(report.error.message);

    expect(report.value.state).toBe("divergent");
    expect(report.value.added).toEqual(["src/new.ts"]);
    expect(report.value.changed).toEqual(["src/app.ts"]);
    expect(report.value.deleted).toEqual(["src/math.ts"]);
    expect(report.value.listsTruncated).toBe(false);
  });

  it("reports unverified when the worktree cannot be walked", async () => {
    await index();
    const snapshot = head();
    const report = await checkCurrency(`${repo.root}-gone`, snapshot, graphConfig());

    expect(report.ok && report.value.state).toBe("unverified");
    expect(report.ok && report.value.reason).toBeDefined();
  });
});
