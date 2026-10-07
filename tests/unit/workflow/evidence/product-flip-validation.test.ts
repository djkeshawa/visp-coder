import { afterEach, expect, it } from "vitest";
import { flipValidationPaths } from "../../../../src/workflow/product/flip-validation.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => workspace?.destroy());
it("uses baseline aliases as well as current ones to identify production imports", async () => {
  const oldConfig = JSON.stringify({
    compilerOptions: { paths: { "@helper": ["tests/helper.mjs"] } },
  });
  const oldSource = "import '@helper';\n";
  workspace = await TestWorkspace.create({
    "src/app.mjs": oldSource,
    "tests/helper.mjs": "export const value=1;\n",
    "tests/other.mjs": "export const value=1;\n",
    "tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@helper": ["tests/other.mjs"] } },
    }),
  });
  const paths = ["src/app.mjs", "tests/helper.mjs", "tests/other.mjs", "tsconfig.json"];
  const baseline = new Map(
    paths.map((path) => [
      path,
      {
        bytes: Buffer.from(
          path === "tsconfig.json"
            ? oldConfig
            : path === "src/app.mjs"
              ? oldSource
              : "export const value=1;\n",
        ),
        mode: 0o644,
      },
    ]),
  );
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["node", "tests/check.mjs"],
      files: ["tests/**"],
      outcomes: ["O001"],
      environment: "node",
    },
    Object.fromEntries(paths.map((path) => [path, "identity"])),
    baseline,
  );
  expect(preserved.has("tests/helper.mjs")).toBe(false);
  expect(preserved.has("tests/other.mjs")).toBe(false);
});

it.each([
  ["from tests import helper", "from tests import other"],
  ["import tests.helper", "import tests.other"],
  ["from . import helper", "from . import other"],
  ["from .tests import helper", "from .tests import other"],
  ["from ..tests import helper", "from ..tests import other"],
])("follows Python submodules in both versions: %s", async (oldImport, currentImport) => {
  const relative = oldImport.startsWith("from .");
  const prefix = relative && !oldImport.startsWith("from ..") ? "src/" : "";
  const directory = oldImport.startsWith("from . import") ? "src" : `${prefix}tests`;
  const files = {
    "src/app.py": `${currentImport}\n`,
    "src/__init__.py": "",
    [`${directory}/__init__.py`]: "",
    [`${directory}/helper.py`]: "value=1\n",
    [`${directory}/other.py`]: "value=2\n",
  };
  workspace = await TestWorkspace.create(files);
  const baseline = new Map(
    Object.entries(files).map(([path, text]) => [
      path,
      { bytes: Buffer.from(path === "src/app.py" ? `${oldImport}\n` : text) },
    ]),
  );
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["python3", "tests/regression.py"],
      files: ["**"],
      verifierFiles: ["**"],
      outcomes: ["O001"],
      environment: "other",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    baseline,
  );
  expect(preserved.has(`${directory}/helper.py`)).toBe(false);
  expect(preserved.has(`${directory}/other.py`)).toBe(false);
});

it("treats a literal dynamic Python import as production reachability", async () => {
  const files = {
    "src/app.py": "import importlib\nhelper=importlib.import_module('tests.helper')\n",
    "tests/helper.py": "value=2\n",
  };
  workspace = await TestWorkspace.create(files);
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["python3", "tests/check.py"],
      files: ["tests/**"],
      outcomes: ["O001"],
      environment: "other",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    new Map(),
  );
  expect(preserved.has("tests/helper.py")).toBe(false);
});

it.each([
  ["importlib with a computed name", "importlib.import_module(name)"],
  ["__import__ with a computed name", "__import__(name)"],
  ["an f-string with interpolation", "importlib.import_module(f'tests.{name}')"],
])("ignores a computed Python dynamic import for reachability: %s", async (_label, call) => {
  const files = {
    "src/app.py": `import importlib\nname = 'helper'\nhelper=${call}\n`,
    "tests/helper.py": "value=2\n",
  };
  workspace = await TestWorkspace.create(files);
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["python3", "tests/check.py"],
      files: ["tests/**"],
      outcomes: ["O001"],
      environment: "other",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    new Map(),
  );
  expect(preserved.has("tests/helper.py")).toBe(true);
});

it("ignores a computed JavaScript dynamic import for reachability", async () => {
  const files = {
    "src/app.mjs": "export async function load(name){ return import(name); }\n",
    "tests/helper.mjs": "export const value=2;\n",
  };
  workspace = await TestWorkspace.create(files);
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["node", "tests/check.mjs"],
      files: ["tests/**"],
      outcomes: ["O001"],
      environment: "node",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    new Map(),
  );
  expect(preserved.has("tests/helper.mjs")).toBe(true);
});

it("treats exported package modules as production independently of verifier declarations", async () => {
  const files = {
    "package.json": JSON.stringify({ exports: "./quality/public.mjs" }),
    "quality/public.mjs": "export const value=2;\n",
    "nested/package.json": JSON.stringify({ main: "quality/public.mjs" }),
    "nested/quality/public.mjs": "export const value=2;\n",
    "extensionless/package.json": JSON.stringify({ main: "quality/public" }),
    "extensionless/quality/public.js": "export const value=2;\n",
    "quality/check.mjs": "import assert from 'node:assert/strict';assert.equal(1,1);\n",
  };
  workspace = await TestWorkspace.create(files);
  const preserved = await flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["node", "quality/check.mjs"],
      files: ["**"],
      verifierFiles: ["**"],
      outcomes: ["O001"],
      environment: "node",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    new Map(),
  );
  expect(preserved.has("quality/public.mjs")).toBe(false);
  expect(preserved.has("nested/quality/public.mjs")).toBe(false);
  expect(preserved.has("extensionless/quality/public.js")).toBe(false);
  expect(preserved.has("quality/check.mjs")).toBe(true);
});

it("reports incomplete Python parses instead of keeping uncertain validation current", async () => {
  const files = { "src/app.py": "from tests import (helper\n", "tests/helper.py": "value=2\n" };
  workspace = await TestWorkspace.create(files);
  await expect(
    flipValidationPaths(
      await workspace.state(),
      {
        id: "C001",
        command: ["python3", "tests/check.py"],
        files: ["tests/**"],
        outcomes: ["O001"],
        environment: "other",
      },
      Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
      new Map(),
    ),
  ).rejects.toThrow("reachability unavailable");
});

async function validationOf(files: Record<string, string>, declared: string[]) {
  workspace = await TestWorkspace.create(files);
  return flipValidationPaths(
    await workspace.state(),
    {
      id: "C001",
      command: ["python3", "tests/regression.py"],
      files: declared,
      outcomes: ["O001"],
      environment: "other",
    },
    Object.fromEntries(Object.keys(files).map((path) => [path, "identity"])),
    new Map(),
  );
}

it.each([
  ["from importlib import import_module as im\nvalue = im('tests.helper').value\n"],
  ["import importlib as il\nvalue = il.import_module('tests.helper').value\n"],
  ["import builtins as b\nvalue = b.__import__('tests.helper').helper.value\n"],
])("treats a literal dynamic import through an alias as reachability: %s", async (source) => {
  const preserved = await validationOf(
    {
      "src/app.py": source,
      "tests/__init__.py": "",
      "tests/helper.py": "value = 1\n",
      "tests/regression.py": "assert True\n",
    },
    ["tests/**"],
  );
  expect(preserved.has("tests/helper.py")).toBe(false);
});

it("ignores a computed name passed to an aliased import", async () => {
  const preserved = await validationOf(
    {
      "src/app.py":
        "from importlib import import_module as im\nname = 'tests.helper'\nvalue = im(name).value\n",
      "tests/__init__.py": "",
      "tests/helper.py": "value = 1\n",
      "tests/regression.py": "assert True\n",
    },
    ["tests/**"],
  );
  expect(preserved.has("tests/helper.py")).toBe(true);
});

it("follows only the imported names of a from-import, never the module name as a submodule", async () => {
  const preserved = await validationOf(
    {
      "src/app.py": "from tests import helper\nvalue = helper.value\n",
      "tests/__init__.py": "",
      "tests/helper.py": "value = 1\n",
      "tests/tests.py": "# validation helper, unrelated to the import\n",
      "tests/regression.py": "assert True\n",
    },
    ["tests/**"],
  );
  expect(preserved.has("tests/helper.py")).toBe(false);
  expect(preserved.has("tests/tests.py")).toBe(true);
});

it("keeps a declared data file under a production source root as implementation", async () => {
  const preserved = await validationOf(
    {
      "src/config/defaults.json": '{"value": 1}\n',
      "tests/regression.py": "assert True\n",
    },
    ["src/config/defaults.json", "tests/**"],
  );
  expect(preserved.has("src/config/defaults.json")).toBe(false);
});

it("reverts a declared data file the product reads at runtime, outside validation directories", async () => {
  const preserved = await validationOf(
    {
      "config/defaults.json": '{"value": 1}\n',
      "tests/regression.py": "assert True\n",
    },
    ["config/defaults.json", "tests/**"],
  );
  expect(preserved.has("config/defaults.json")).toBe(false);
});

it("keeps a declared fixture inside a validation directory as validation", async () => {
  const preserved = await validationOf(
    {
      "tests/fixtures/data.json": '{"value": 1}\n',
      "tests/regression.py": "assert True\n",
    },
    ["tests/fixtures/data.json", "tests/**"],
  );
  expect(preserved.has("tests/fixtures/data.json")).toBe(true);
});
