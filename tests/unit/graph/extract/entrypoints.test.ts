import { afterEach, describe, expect, it } from "vitest";
import type { Entrypoint } from "../../../../src/graph/types.js";
import { extractFixture, type Fixture, makeRepo } from "../fixtures.js";

let repo: Fixture;

afterEach(async () => {
  await repo?.cleanup();
});

function of(entrypoints: readonly Entrypoint[], kind: Entrypoint["kind"]): Entrypoint[] {
  return entrypoints.filter((entrypoint) => entrypoint.kind === kind);
}

describe("entrypoint binding", () => {
  it("binds express routes from a literal path and a handler", async () => {
    repo = await makeRepo({
      "src/server.js": [
        'import express from "express";',
        "const app = express();",
        'app.get("/users", (req, res) => res.json([]));',
        'app.post("/users", (req, res) => res.json({}));',
        "const cache = new Map();",
        'cache.get("/users");',
        "",
      ].join("\n"),
    });
    const facts = await extractFixture(repo);
    const routes = of(facts.entrypoints, "http_route");

    expect(routes.map((route) => route.name).sort()).toEqual(["/users", "/users"]);
    expect(routes[0]?.evidence).toContain("app.get");
  });

  it("binds flask and fastapi decorators", async () => {
    repo = await makeRepo({
      "api.py": [
        "from flask import Flask",
        "",
        "app = Flask(__name__)",
        "",
        "",
        '@app.route("/health")',
        "def health():",
        '    return "ok"',
        "",
      ].join("\n"),
    });
    const facts = await extractFixture(repo);

    expect(of(facts.entrypoints, "http_route")[0]).toMatchObject({
      name: "/health",
      path: "api.py",
    });
  });

  it("binds commander commands", async () => {
    repo = await makeRepo({
      "src/tool.js": [
        'import { Command } from "commander";',
        "const program = new Command();",
        'program.command("build").description("build it");',
        "",
      ].join("\n"),
    });
    const facts = await extractFixture(repo);

    expect(of(facts.entrypoints, "cli_command").map((entry) => entry.name)).toEqual(["build"]);
  });

  it("binds click, typer and argparse commands", async () => {
    repo = await makeRepo({
      "cli_click.py": [
        "import click",
        "",
        "",
        "@click.command()",
        "def run():",
        "    pass",
        "",
      ].join("\n"),
      "cli_argparse.py": [
        "import argparse",
        "",
        "parser = argparse.ArgumentParser()",
        "sub = parser.add_subparsers()",
        'sub.add_parser("serve")',
        "",
      ].join("\n"),
    });
    const facts = await extractFixture(repo);
    const names = of(facts.entrypoints, "cli_command")
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual(["run", "serve"]);
  });

  it("does not bind an entrypoint from a filename alone", async () => {
    repo = await makeRepo({
      "src/cli.ts": "export const notACommand = 1;\n",
      "src/server.ts": "export const alsoNot = 2;\n",
      "src/routes.ts": 'export const path = "/users";\n',
    });
    const facts = await extractFixture(repo);

    expect(facts.entrypoints).toHaveLength(0);
  });

  it("reads package.json entrypoints and scripts", async () => {
    repo = await makeRepo({
      "package.json": JSON.stringify(
        {
          name: "demo",
          main: "dist/index.js",
          bin: { demo: "dist/cli.js" },
          exports: { ".": "./dist/index.js" },
          scripts: { build: "tsup", test: "vitest run" },
        },
        null,
        2,
      ),
    });
    const facts = await extractFixture(repo);

    expect(
      of(facts.entrypoints, "package_entrypoint")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["demo", "exports", "main"]);
    expect(
      of(facts.entrypoints, "package_script")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["build", "test"]);
  });

  it("binds a test entrypoint only from evidence in the file", async () => {
    repo = await makeRepo({
      "tests/real.test.ts": [
        'import { describe, it } from "vitest";',
        'describe("x", () => it("y", () => undefined));',
        "",
      ].join("\n"),
      "tests/helpers.ts": "export const helper = 1;\n",
      "tests/test_thing.py": ["def test_thing():", "    assert True", ""].join("\n"),
    });
    const facts = await extractFixture(repo);
    const tests = of(facts.entrypoints, "test_entrypoint").map((entry) => entry.path);

    expect(tests.sort()).toEqual(["tests/real.test.ts", "tests/test_thing.py"]);
  });
});
