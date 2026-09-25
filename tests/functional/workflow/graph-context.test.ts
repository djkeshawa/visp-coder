import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { productProject } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject({
    files: {
      "src/auth/token.ts": "export function makeToken(user: string) { return user + '-token'; }",
      "src/auth/login.ts":
        "import {makeToken} from './token.js'; export function login(u:string){return makeToken(u);}",
      "src/billing.ts": "export function invoice(){return 1;}",
      "tests/token.test.ts":
        "import {makeToken} from '../src/auth/token.js'; import {test} from 'node:test';test('token',()=>makeToken('a'));",
    },
    definition: {
      outcomes: [{ id: "O001", kind: "functional", statement: "Tokens support login" }],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--version"],
          outcomes: ["O001"],
          files: ["tests/token.test.ts"],
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Harden the existing token helper",
          outcomes: ["O001"],
          scope: { allowed: ["src/auth/token.ts"] },
          checks: ["C001"],
        },
      ],
    },
  }));
});
afterEach(async () => project?.destroy());
describe("bounded repository context", () => {
  it("delivers selected source, relevant tests and structural relationships without granting neighboring edit scope", () => {
    const work = project.json<{
      files: { path: string }[];
      graph: unknown[];
      scope: { allowed: string[] };
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("src/auth/token.ts");
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("tests/token.test.ts");
    expect(work.envelope.data?.files.map((file) => file.path)).not.toContain("src/billing.ts");
    expect(work.envelope.data?.graph.length).toBeGreaterThan(0);
    expect(work.envelope.data?.scope.allowed).toEqual(["src/auth/token.ts"]);
    expect(
      project.json<{ allowed: boolean }>("guard", "--path", "src/auth/login.ts").envelope.data
        ?.allowed,
    ).toBe(false);
  });
  it("withholds stale relationships during inspection and restores them only after refresh", async () => {
    expect(project.run("work").exitCode).toBe(0);
    await project.write(
      "src/auth/token.ts",
      "export function replacementToken() { return 'new'; }\n",
    );
    const inspect = project.json<{
      graph: unknown[];
      notes: string[];
      scope: { allowed: string[] };
    }>("work", "--inspect");
    expect(inspect.result.exitCode, inspect.result.stdout).toBe(0);
    expect(inspect.envelope.data?.graph).toEqual([]);
    expect(inspect.envelope.data?.notes.join(" ")).toContain("index is divergent");
    expect(inspect.envelope.data?.scope.allowed).toEqual(["src/auth/token.ts"]);
    const refreshed = project.json<{ graph: { name: string }[] }>("work");
    expect(refreshed.result.exitCode, refreshed.result.stdout).toBe(0);
    expect(refreshed.envelope.data?.graph.some((row) => row.name === "replacementToken")).toBe(
      true,
    );
    expect(refreshed.envelope.data?.graph.some((row) => row.name === "makeToken")).toBe(false);
  });
  it("includes newly created declared files when a previous graph already exists", async () => {
    project.run("work");
    await project.write(
      "src/auth/new-token.ts",
      "export function parseNewToken(value:string){return value;}",
    );
    const brief = project.json<ProductBrief>("brief").envelope.data;
    if (!brief) throw new Error("Missing brief");
    await project.authorBrief(
      feature,
      {
        slices: brief.slices.map((slice) => ({
          ...slice,
          scope: { ...slice.scope, allowed: [...slice.scope.allowed, "src/auth/new-token.ts"] },
        })),
      },
      "Add the selected parser",
    );
    const work = project.json<{ files: { path: string }[] }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.files.map((file) => file.path)).toContain("src/auth/new-token.ts");
  });
  it("bounds actual delivered source and identifies truncation", async () => {
    await project.write(
      "src/auth/token.ts",
      `export const token = 1;\n${"// detail\n".repeat(10000)}`,
    );
    const work = project.json<{
      files: { path: string; content: string; truncated: boolean }[];
      notes: string[];
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    const file = work.envelope.data?.files.find((entry) => entry.path === "src/auth/token.ts");
    expect(file?.truncated).toBe(true);
    expect(file?.content.length).toBeLessThanOrEqual(6000);
    expect(work.result.stdout.length).toBeLessThan(40000);
  });
  it("prioritizes the named target through the public work command in a broad scope", async () => {
    const noise = Array.from({ length: 6 }, (_, index) => `src/part${index}.ts`);
    for (const [index, path] of noise.entries())
      await project.write(path, `export const unrelated${index} = ${index};`);
    const brief = project.json<ProductBrief>("brief").envelope.data;
    if (!brief) throw new Error("Missing brief");
    await project.authorBrief(
      feature,
      {
        slices: brief.slices.map((slice) => ({
          ...slice,
          goal: "Harden makeToken without breaking its callers",
          scope: { ...slice.scope, allowed: [...noise, "src/auth/token.ts"] },
        })),
      },
      "Broaden the task while retaining its named target",
    );
    const work = project.json<{
      graph: { name: string; path: string }[];
      scope: { allowed: string[] };
      notes: string[];
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    const data = work.envelope.data;
    expect(data?.graph.some((row) => row.name === "makeToken")).toBe(true);
    expect(data?.graph.some((row) => row.path === "src/auth/login.ts")).toBe(true);
    expect(data?.graph.some((row) => row.path === "tests/token.test.ts")).toBe(true);
    expect(data?.scope.allowed).not.toContain("src/auth/login.ts");
    expect(data?.notes.join(" ")).toContain("named targets take priority");
  });
});
