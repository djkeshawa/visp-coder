import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { loadAliases, parseJsonc } from "../../../../src/graph/extract/tsconfig.js";
import { type Fixture, makeRepo } from "../fixtures.js";

let repo: Fixture;
let outside = "";

afterEach(async () => {
  await repo?.cleanup();
  if (outside) await rm(outside, { recursive: true, force: true });
});

describe("tsconfig alias confinement", () => {
  it("follows nested parent inheritance that stays inside the project", async () => {
    repo = await makeRepo({
      "tsconfig.json": '{"extends":"./config/child.json"}',
      "config/child.json": '{"extends":"../shared.json"}',
      "shared.json": '{"compilerOptions":{"paths":{"@shared/*":["src/*"]}}}',
    });
    const aliases = await loadAliases(repo.root);
    expect(aliases.problems).toEqual([]);
    expect(aliases.aliases).toEqual([{ pattern: "@shared/*", targets: ["src/*"] }]);
    expect(aliases.sources.map((source) => source.path)).toEqual([
      "tsconfig.json",
      "config/child.json",
      "shared.json",
    ]);
  });

  it("does not follow a confined spelling through an external symlink", async () => {
    outside = await mkdtemp(join(tmpdir(), "visp-alias-symlink-"));
    await writeFile(
      join(outside, "shared.json"),
      '{"compilerOptions":{"paths":{"secret":["secret.ts"]}}}',
    );
    repo = await makeRepo({ "tsconfig.json": '{"extends":"./external/shared.json"}' });
    await symlink(outside, join(repo.root, "external"), "dir");
    const aliases = await loadAliases(repo.root);
    expect(aliases.aliases).toEqual([]);
    expect(aliases.problems).toContain("external/shared.json");
    expect(aliases.sources.at(-1)?.identity).toMatch(/^unreadable:/);
  });
  it("does not follow an extends path outside the project", async () => {
    outside = await mkdtemp(join(tmpdir(), "visp-alias-outside-"));
    const externalConfig = join(outside, "tsconfig.json");
    await writeFile(
      externalConfig,
      JSON.stringify({ compilerOptions: { paths: { "@outside/*": ["secret/*"] } } }),
      "utf8",
    );
    repo = await makeRepo({ "tsconfig.json": "{}" });
    const escaped = relative(repo.root, externalConfig).replace(/\\/g, "/");
    await repo.write("tsconfig.json", JSON.stringify({ extends: escaped }));

    const aliases = await loadAliases(repo.root);

    expect(escaped.split("/")).toContain("..");
    expect(aliases.aliases).toEqual([]);
    expect(aliases.problems).toContain(`tsconfig.json extends ${escaped}`);
  });

  it.each([
    "/outside/tsconfig.json",
    "C:\\outside\\tsconfig.json",
    "\\\\host\\share\\tsconfig.json",
  ])("rejects absolute extends path %s", async (extendsPath) => {
    repo = await makeRepo({
      "tsconfig.json": JSON.stringify({ extends: extendsPath }),
    });

    const aliases = await loadAliases(repo.root);

    expect(aliases.aliases).toEqual([]);
    expect(aliases.problems).toContain(`tsconfig.json extends ${extendsPath}`);
  });
});

describe("JSONC compatibility", () => {
  it("preserves commas, closing braces, escaped quotes, and comment text inside strings", () => {
    const source = String.raw`{
      // Keep strings intact while accepting real trailing commas.
      "compilerOptions": {"paths": {"@odd/*": ["./source,}", "./source,]", "./say\\\"//,}",],},},
    }`;
    expect(parseJsonc(source)).toEqual(
      ts.parseConfigFileTextToJson("tsconfig.json", source).config,
    );
    const paths = parseJsonc(source)?.compilerOptions as { paths: Record<string, string[]> };
    expect(paths.paths["@odd/*"]?.slice(0, 2)).toEqual(["./source,}", "./source,]"]);
  });
});
