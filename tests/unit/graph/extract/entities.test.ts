import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EntityKind } from "../../../../src/graph/types.js";
import { extractFixture, type Fixture, makeRepo, TS_SOURCES } from "../fixtures.js";

let repo: Fixture;

afterEach(async () => {
  await repo?.cleanup();
});

/** `kind:name` pairs, because one file can hold a function and a method of the same name. */
function declarationsIn(
  entities: readonly { path: string; name: string; kind: EntityKind }[],
  path: string,
): Set<string> {
  return new Set(
    entities
      .filter((entity) => entity.path === path)
      .map((entity) => `${entity.kind}:${entity.name}`),
  );
}

describe("entity extraction", () => {
  beforeEach(async () => {
    repo = await makeRepo(TS_SOURCES);
  });

  it("finds TypeScript declarations with their kinds", async () => {
    const facts = await extractFixture(repo);
    const declarations = declarationsIn(facts.entities, "src/math.ts");

    expect(declarations).toContain("file:math.ts");
    expect(declarations).toContain("function:add");
    expect(declarations).toContain("function:double");
    expect(declarations).toContain("interface:Adder");
    expect(declarations).toContain("type:Sum");
    expect(declarations).toContain("class:Calculator");
    expect(declarations).toContain("method:total");
  });

  it("records line ranges that bracket the declaration", async () => {
    const facts = await extractFixture(repo);
    const add = facts.entities.find(
      (entity) => entity.name === "add" && entity.kind === "function",
    );

    expect(add?.startLine).toBe(1);
    expect(add?.endLine).toBe(3);
  });

  it("links a file to what it defines and a class to its methods", async () => {
    const facts = await extractFixture(repo);
    const defines = facts.relations.filter(
      (relation) => relation.kind === "defines" && relation.path === "src/math.ts",
    );
    const contains = facts.relations.filter((relation) => relation.kind === "contains");

    expect(defines.length).toBeGreaterThan(0);
    expect(defines.every((relation) => relation.source === "src/math.ts#file")).toBe(true);
    expect(contains.some((relation) => relation.source.includes("class:Calculator"))).toBe(true);
  });
});

describe("entity extraction across languages", () => {
  beforeEach(async () => {
    repo = await makeRepo({
      "app/util.py": ["VALUE = 1", "", "", "def helper(x):", "    return x", ""].join("\n"),
      "app/service.py": [
        "from .util import helper",
        "",
        "",
        "class Service:",
        "    def run(self):",
        "        return helper(1)",
        "",
      ].join("\n"),
      "web/widget.js": ["export function render() {", "  return 1;", "}", ""].join("\n"),
    });
  });

  it("finds Python and JavaScript declarations", async () => {
    const facts = await extractFixture(repo);
    const util = declarationsIn(facts.entities, "app/util.py");
    const service = declarationsIn(facts.entities, "app/service.py");
    const widget = declarationsIn(facts.entities, "web/widget.js");

    expect(util).toContain("function:helper");
    expect(util).toContain("variable:VALUE");
    expect(service).toContain("class:Service");
    expect(service).toContain("method:run");
    expect(widget).toContain("function:render");
  });

  it("reports coverage per language so an empty graph is explainable", async () => {
    const facts = await extractFixture(repo);
    const python = facts.languageCoverage.find((entry) => entry.language === "python");

    expect(python).toEqual({ language: "python", totalFiles: 2, parsedFiles: 2 });
  });
});
