import { afterEach, describe, expect, it } from "vitest";
import type { UnknownKind, UnknownRecord } from "../../../../src/graph/types.js";
import { extractFixture, type Fixture, graphConfig, makeRepo } from "../fixtures.js";

let repo: Fixture;

afterEach(async () => {
  await repo?.cleanup();
});

function kinds(unknowns: readonly UnknownRecord[]): Set<UnknownKind> {
  return new Set(unknowns.map((record) => record.kind));
}

describe("unknown records", () => {
  it("records a parser error for a file that will not parse", async () => {
    repo = await makeRepo({ "src/broken.ts": "export function ( { ]]]\n" });
    const facts = await extractFixture(repo);

    expect(facts.unknowns).toContainEqual({
      kind: "parser_error",
      path: "src/broken.ts",
      detail: "syntax error in source",
    });
  });

  it("records a dynamic import whose specifier is computed", async () => {
    repo = await makeRepo({
      "src/loader.ts": [
        "export async function load(name: string) {",
        '  return import("./plugins/" + name + ".js");',
        "}",
        "",
      ].join("\n"),
    });
    const facts = await extractFixture(repo);
    const dynamic = facts.unknowns.filter((record) => record.kind === "dynamic_import");

    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]?.path).toBe("src/loader.ts");
  });

  it("records a relative import that resolves to nothing", async () => {
    repo = await makeRepo({
      "src/a.ts": 'import { gone } from "./missing.js";\nexport { gone };\n',
    });
    const facts = await extractFixture(repo);

    expect(facts.unknowns).toContainEqual({
      kind: "unresolved_import",
      path: "src/a.ts",
      detail: "./missing.js",
    });
  });

  it("records unresolved calls rather than guessing a target", async () => {
    repo = await makeRepo({ "src/a.ts": "export function go() {\n  return mystery(1);\n}\n" });
    const facts = await extractFixture(repo);

    expect(facts.unknowns).toContainEqual({
      kind: "unresolved_call",
      path: "src/a.ts",
      detail: "mystery",
    });
  });

  it("records one unsupported-language marker per extension", async () => {
    repo = await makeRepo({
      "main.go": "package main\n",
      "other.go": "package other\n",
      "notes.md": "# hi\n",
    });
    const facts = await extractFixture(repo);
    const unsupported = facts.unknowns.filter((r) => r.kind === "unsupported_language");

    expect(unsupported.map((record) => record.detail).sort()).toEqual([".go"]);
  });

  it("records a disabled language as unsupported rather than dropping it", async () => {
    repo = await makeRepo({ "app.py": "def f():\n    pass\n" });
    const facts = await extractFixture(repo, graphConfig({ languages: ["typescript"] }));

    expect(kinds(facts.unknowns)).toContain("unsupported_language");
    expect(facts.languageCoverage).toContainEqual({
      language: "python",
      totalFiles: 1,
      parsedFiles: 0,
    });
  });

  it("records a skipped file as an explicit unknown", async () => {
    repo = await makeRepo({ "src/big.ts": "x".repeat(4096) });
    const facts = await extractFixture(repo, graphConfig({ maxFileBytes: 512 }));

    expect(facts.unknowns).toContainEqual({
      kind: "file_skipped",
      path: "src/big.ts",
      detail: "too_large",
    });
  });
});
