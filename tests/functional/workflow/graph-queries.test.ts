import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

/**
 * Query ergonomics. Naming a symbol or a file is what a person types, so those
 * must either work or say why not — a bare "no results" for an unresolvable
 * target reads as "nothing depends on this", which is a different claim.
 */
describe("querying an indexed repository", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create({
      "src/token.ts": "export function makeToken(user: string) {\n  return user;\n}\n",
      "src/login.ts":
        'import { makeToken } from "./token.js";\nexport function login(u: string) {\n  return makeToken(u);\n}\n',
      "tests/token.test.ts":
        'import { makeToken } from "../src/token.js";\nimport { test } from "node:test";\ntest("t", () => makeToken("a"));\n',
    });
    project.run("init", "--harness", "generic");
    project.run("index");
  });

  afterAll(async () => {
    await project.destroy();
  });

  it("describes what is in the repository", () => {
    const result = project.run("query", "describe");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("entities");
  });

  it("exposes traversal limits and explains incomplete answers", () => {
    const { result, envelope } = project.json<{
      receipt: {
        truncated: boolean;
        budget: { depth: number; results: number; nodes: number; edges: number };
        work: { visitedNodes: number };
      };
    }>(
      "query",
      "neighbors",
      "makeToken",
      "--nodes",
      "1",
      "--edges",
      "2",
      "--depth",
      "2",
      "--results",
      "3",
    );
    expect(result.exitCode).toBe(0);
    expect(envelope.data?.receipt).toMatchObject({
      truncated: true,
      budget: { depth: 2, results: 3, nodes: 1, edges: 2 },
      work: { visitedNodes: 1 },
    });
    const text = project.run("query", "neighbors", "makeToken", "--nodes", "1");
    expect(text.stdout).toContain("increase --nodes or --edges");
    expect(text.stdout).not.toContain("ask for more with --results");
  });

  it("finds a symbol by name", () => {
    const result = project.run("query", "search", "makeToken");
    expect(result.stdout).toContain("src/token.ts");
    expect(result.stdout).toContain("makeToken");
  });

  it("lists what a file defines when given a path", () => {
    const result = project.run("query", "search", "src/token.ts");
    expect(result.stdout).toContain("makeToken");
  });

  it("resolves a symbol name to an entity for callers", () => {
    const result = project.run("query", "callers", "makeToken");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Reading src/token.ts#");
    expect(result.stdout).toContain("src/login.ts");
  });

  it("asks for a symbol when given a whole file", () => {
    const result = project.run("query", "callers", "src/token.ts");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("needs one symbol");
    expect(result.stderr).toContain("#");
  });

  it("says nothing matched rather than returning an empty answer", () => {
    const result = project.run("query", "callers", "noSuchSymbol");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Nothing in the index matches");
  });

  it("names the tests covering a file", () => {
    const result = project.run("query", "testsFor", "src/token.ts");
    expect(result.stdout).toContain("tests/token.test.ts");
  });

  it("reports what depends on a file", () => {
    const result = project.run("query", "impact", "src/token.ts");
    expect(result.stdout).toContain("src/login.ts");
  });

  it("rejects an unknown operation with the list of valid ones", () => {
    const result = project.run("query", "nonsense");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("describe");
  });
});
