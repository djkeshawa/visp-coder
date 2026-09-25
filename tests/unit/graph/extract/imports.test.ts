import { afterEach, describe, expect, it } from "vitest";
import type { Relation } from "../../../../src/graph/types.js";
import { extractFixture, type Fixture, makeRepo, TS_SOURCES } from "../fixtures.js";

let repo: Fixture;

afterEach(async () => {
  await repo?.cleanup();
});

function targetsFrom(relations: readonly Relation[], path: string, kind: Relation["kind"]) {
  return relations
    .filter((relation) => relation.path === path && relation.kind === kind)
    .map((relation) => relation.target);
}

describe("import resolution", () => {
  it("resolves a relative TypeScript import written with a .js extension", async () => {
    repo = await makeRepo(TS_SOURCES);
    const facts = await extractFixture(repo);

    expect(targetsFrom(facts.relations, "src/app.ts", "imports")).toContain("src/math.ts#file");
  });

  it("resolves an import through a tsconfig paths alias", async () => {
    repo = await makeRepo({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
      }),
      "src/lib/format.ts": "export const format = (s: string) => s;\n",
      "src/use.ts": 'import { format } from "@lib/format";\nexport const go = () => format("x");\n',
    });
    const facts = await extractFixture(repo);

    expect(targetsFrom(facts.relations, "src/use.ts", "imports")).toContain(
      "src/lib/format.ts#file",
    );
  });

  it("follows a tsconfig extends chain", async () => {
    repo = await makeRepo({
      "tsconfig.base.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
      }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
      "src/core.ts": "export const core = 1;\n",
      "src/main.ts": 'import { core } from "~/core";\nexport const value = core;\n',
    });
    const facts = await extractFixture(repo);

    expect(targetsFrom(facts.relations, "src/main.ts", "imports")).toContain("src/core.ts#file");
  });

  it("resolves Python packages and __init__ modules", async () => {
    repo = await makeRepo({
      "pkg/__init__.py": "VALUE = 1\n",
      "pkg/inner.py": "from . import VALUE\n",
      "main.py": "import pkg.inner\n",
    });
    const facts = await extractFixture(repo);

    expect(targetsFrom(facts.relations, "main.py", "imports")).toContain("pkg/inner.py#file");
    expect(targetsFrom(facts.relations, "pkg/inner.py", "imports")).toContain(
      "pkg/__init__.py#file",
    );
  });

  it("marks a package outside the repository as external, not as an import", async () => {
    repo = await makeRepo({ "src/a.ts": 'import { z } from "zod";\nexport const s = z;\n' });
    const facts = await extractFixture(repo);

    expect(targetsFrom(facts.relations, "src/a.ts", "external")).toContain("external:zod");
    expect(targetsFrom(facts.relations, "src/a.ts", "imports")).toHaveLength(0);
  });

  it("maps a test file to the module it imports", async () => {
    repo = await makeRepo(TS_SOURCES);
    const facts = await extractFixture(repo);
    const tested = facts.relations.filter((relation) => relation.kind === "tested_by");

    expect(tested).toContainEqual(
      expect.objectContaining({ source: "src/math.ts#file", target: "tests/math.test.ts#file" }),
    );
  });

  it("records calls between files it can bind by name", async () => {
    repo = await makeRepo(TS_SOURCES);
    const facts = await extractFixture(repo);
    const calls = facts.relations.filter(
      (relation) => relation.kind === "calls" && relation.path === "src/app.ts",
    );

    expect(calls.map((relation) => relation.target)).toContain("src/math.ts#function:add");
    expect(calls.every((relation) => relation.source === "src/app.ts#function:run")).toBe(true);
  });
});
