import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { querySnapshot } from "../../../../src/graph/query/index.js";
import type { QueryArgs, QueryBudget } from "../../../../src/graph/query/types.js";
import type { GraphSnapshot } from "../../../../src/graph/types.js";
import { type Fixture, indexFixture, makeRepo, TS_SOURCES } from "../fixtures.js";

let repo: Fixture;
let snapshot: GraphSnapshot;

beforeEach(async () => {
  repo = await makeRepo({
    ...TS_SOURCES,
    "package.json": JSON.stringify({ name: "demo", scripts: { build: "tsup" } }, null, 2),
  });
  snapshot = await indexFixture(repo);
});

afterEach(async () => {
  await repo.cleanup();
});

function ask(
  operation: Parameters<typeof querySnapshot>[1],
  args: QueryArgs = {},
  budget?: Partial<QueryBudget>,
) {
  const result = querySnapshot(snapshot, operation, args, budget);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("describe", () => {
  it("summarises the repository and lists bound entrypoints", () => {
    const answer = ask("describe");

    expect(answer.summary?.files).toBe(Object.keys(TS_SOURCES).length + 1);
    expect(answer.summary?.languageCoverage.some((c) => c.language === "typescript")).toBe(true);
    expect(answer.rows.some((row) => row.name === "build")).toBe(true);
  });
});

describe("search", () => {
  it("matches entity names by substring", () => {
    const answer = ask("search", { name: "calc" });
    expect(answer.rows.map((row) => row.name)).toContain("Calculator");
  });

  it("says plainly when nothing matches", () => {
    const answer = ask("search", { name: "nosuchthing" });
    expect(answer.rows).toHaveLength(0);
    expect(answer.notes.join(" ")).toContain("nosuchthing");
  });
});

describe("entity", () => {
  it("returns the entity with its immediate relations", () => {
    const answer = ask("entity", { entity: "src/math.ts#function:add" });

    const self = answer.rows.find((row) => row.kind === "entity");
    expect(self?.name).toBe("add");
    expect(self?.key).toBe("src/math.ts#function:add");
    expect(answer.rows.some((row) => row.kind === "relation")).toBe(true);
  });

  it("reports a reference it does not know", () => {
    const answer = ask("entity", { entity: "src/nope.ts#file" });
    expect(answer.notes.join(" ")).toContain("src/nope.ts#file");
  });
});

describe("traversal operations", () => {
  it("finds callers and callees of a function", () => {
    const callers = ask("callers", { entity: "src/math.ts#function:add" });
    const callees = ask("callees", { entity: "src/app.ts#function:run" });

    expect(callers.rows.map((row) => row.key)).toContain("src/app.ts#function:run");
    expect(callees.rows.map((row) => row.key)).toContain("src/math.ts#function:add");
  });

  it("reports neighbours with their hop distance", () => {
    const answer = ask("neighbors", { path: "src/app.ts" }, { depth: 1 });
    expect(answer.rows.every((row) => row.distance === 1)).toBe(true);
    expect(answer.rows.map((row) => row.key)).toContain("src/math.ts#file");
  });

  it("traces a shortest path between two entities", () => {
    const answer = ask("tracePath", {
      from: "src/app.ts#file",
      to: "src/math.ts#function:add",
    });

    expect(answer.rows[0]?.key).toBe("src/app.ts#file");
    expect(answer.rows.at(-1)?.key).toBe("src/math.ts#function:add");
    expect(answer.rows.map((row) => row.distance)).toEqual(answer.rows.map((_, i) => i));
  });

  it("says when no path exists within the depth", () => {
    const answer = ask(
      "tracePath",
      { from: "src/app.ts#file", to: "src/math.ts#function:add" },
      { depth: 1 },
    );
    expect(answer.rows).toHaveLength(0);
    expect(answer.notes.join(" ")).toContain("no path");
  });

  it("finds the tests that import a module", () => {
    const answer = ask("testsFor", { path: "src/math.ts" });
    expect(answer.rows.map((row) => row.path)).toContain("tests/math.test.ts");
  });

  it("reports what depends on a module", () => {
    const answer = ask("impact", { path: "src/math.ts" }, { depth: 2 });
    expect(answer.rows.map((row) => row.path)).toContain("src/app.ts");
  });
});

describe("unknowns", () => {
  it("filters by kind", () => {
    const answer = ask("unknowns", { kind: "unresolved_call" });
    expect(answer.unknowns.every((record) => record.kind === "unresolved_call")).toBe(true);
    expect(answer.notes.join(" ")).toContain("unresolved_call");
  });
});
