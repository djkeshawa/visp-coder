import { expect, it } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { classifyFlip } from "../../../../src/workflow/product/flip-check.js";

const check: import("../../../../src/workflow/product/model.js").ProductCheck = {
  id: "C001",
  command: ["node", "--test", "tests/regression.test.mjs"],
  files: [],
  outcomes: ["O001"],
  environment: "node" as const,
};
it.each([
  ["AssertionError: value differs\nnot ok 1 - regression", true, "behavioral"],
  ["SyntaxError: invalid syntax\nFAILED (errors=1)", "unchecked", undefined],
  ["/tmp/tree/src/value.mjs:1\nSyntaxError: invalid syntax\nFAILED (errors=1)", true, "structural"],
  [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/tree/src/value.mjs' imported from /tmp/tree/tests/regression.test.mjs",
    true,
    "structural",
  ],
  [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'missing-dependency' imported from /tmp/tree/src/value.mjs",
    "unchecked",
    undefined,
  ],
  [
    "ModuleNotFoundError: No module named 'pytest'\nFile '/tmp/tree/src/value.mjs'",
    "unchecked",
    undefined,
  ],
  ["[ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY] setup failed", "unchecked", undefined],
  ["ERROR at setup of test_value\nFAILED", "unchecked", undefined],
  [
    "File 'tests/regression.py', line 3, in setUp\nValueError: bad fixture\nFAILED (errors=1)",
    "unchecked",
    undefined,
  ],
  [
    "FileNotFoundError: [Errno 2] No such file or directory: 'fixtures/data.json'\nFAILED (errors=1)",
    "unchecked",
    undefined,
  ],
  [
    "ImportError: cannot import name 'missing' from 'dependency' (/tmp/tree/vendor/dependency.py)\nFAILED (errors=1)",
    "unchecked",
    undefined,
  ],
  [
    "ImportError: cannot import name 'value' from 'value' (/tmp/tree/src/value.mjs)\nERROR collecting tests/regression.py",
    true,
    "structural",
  ],
  [
    "ERROR collecting tests/regression.py\nValueError: missing configuration\nFAILED (errors=1)",
    "unchecked",
    undefined,
  ],
  [
    "File 'tests/regression.py', line 3, in setUp\nModuleNotFoundError: No module named 'src.value'\nFAILED (errors=1)",
    "unchecked",
    undefined,
  ],
  ["environment broke with exit 1", "unchecked", undefined],
] as const)("classifies %s conservatively", (stdout, expected, signal) => {
  const output = ok({
    command: "node",
    exitCode: 1,
    stdout,
    stderr: "",
    durationMs: 12,
    timedOut: false,
  });
  expect(
    classifyFlip(
      output,
      check,
      ["src/value.mjs"],
      ["tests/regression.test.mjs"],
      "/tmp/tree",
      (text) => text,
    ),
  ).toMatchObject({ failsWithoutChange: expected });
  expect(
    classifyFlip(output, check, ["src/value.mjs"], [], "/tmp/tree", (text) => text).signal,
  ).toBe(signal);
});

const pythonCheck: import("../../../../src/workflow/product/model.js").ProductCheck = {
  id: "C001",
  command: ["python3", "-m", "unittest"],
  files: [],
  outcomes: ["O001"],
  environment: "other" as const,
};
function classifyOutput(
  stdout: string,
  reverted: string[],
  root = "/tmp/tree",
  checkDefinition = check,
) {
  return classifyFlip(
    ok({ command: "node", exitCode: 1, stdout, stderr: "", durationMs: 1, timedOut: false }),
    checkDefinition,
    reverted,
    [],
    root,
    (text) => text,
  );
}

// Real node:test output for a before() hook that throws (frames name TestHook and Test.createHook).
const NODE_BEFORE_HOOK = [
  "✖ value (0.375545ms)",
  "ℹ tests 1",
  "ℹ fail 1",
  "",
  "✖ failing tests:",
  "",
  "test at hook.test.mjs:5:1",
  "✖ value (0.375545ms)",
  "  Error: fixture data.json is missing",
  "      at TestContext.<anonymous> (file:///tmp/tree/hook.test.mjs:4:22)",
  "      at TestHook.runInAsyncScope (node:async_hooks:226:14)",
  "      at TestHook.run (node:internal/test_runner/test:1397:25)",
  "      at Test.createHook (node:internal/test_runner/test:1112:33)",
].join("\n");

it.each([
  ["node:test before hook", NODE_BEFORE_HOOK],
  [
    "node:test after hook at file level",
    "✖ /tmp/tree/hook.test.mjs (0.15953ms)\n  Error: after cleanup failed\n      at TestHook.run (node:internal/test_runner/test:1397:25)\n      at Test.runHook (node:internal/test_runner/test:1284:20)",
  ],
  [
    "vitest beforeAll failing a suite",
    '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  hook.test.mjs > suite\nError: fixture data.json is missing\n ❯ hook.test.mjs:4:27\n      3| describe("suite", () => {\n      4|   beforeAll(() => { throw new Error("fixture data.json is missing"); });',
  ],
  [
    "vitest beforeEach failing a test",
    ' FAIL  each.test.mjs > value\nError: beforeEach fixture missing\n ❯ each.test.mjs:3:26\n      2| import { value } from "./value.mjs";\n      3| beforeEach(() => { throw new Error("beforeEach fixture missing"); });',
  ],
  ["unittest class fixture", "ERROR: setUpClass (tests.test_value.Regression)\nFAILED (errors=1)"],
  ["pytest fixture", "ERROR at setup of test_value\n=== 1 error in 0.01s ==="],
])("treats a %s failure as unchecked, never as a positive flip", (_name, stdout) => {
  expect(classifyOutput(stdout, ["value.mjs"], "/tmp/tree", check)).toMatchObject({
    failsWithoutChange: "unchecked",
  });
});

it("keeps a vitest assertion inside a test body as a behavioral failure", () => {
  const stdout =
    ' FAIL  plain.test.mjs > value\nAssertionError: expected 1 to be 2 // Object.is equality\n ❯ plain.test.mjs:3:33\n      3| it("value", () => expect(value).toBe(2));';
  expect(classifyOutput(stdout, ["value.mjs"])).toMatchObject({
    failsWithoutChange: true,
    signal: "behavioral",
  });
});

// A missing fixture whose path ends like a reverted file is not that reverted file.
it("does not attribute a missing fixture to a reverted file that shares its trailing path", () => {
  const stdout =
    "ERROR: test_load (test_cfg.Cfg.test_load)\nTraceback (most recent call last):\n  File 'tests/test_cfg.py', line 4, in test_load\n    open('fixtures/config/app.json')\nFileNotFoundError: [Errno 2] No such file or directory: 'fixtures/config/app.json'\nFAILED (errors=1)";
  expect(classifyOutput(stdout, ["config/app.json"], "/tmp/tree", pythonCheck)).toMatchObject({
    failsWithoutChange: "unchecked",
  });
});

it("does not attribute a pytest fixture under tests/ to a reverted root data.json", () => {
  const stdout =
    "E   FileNotFoundError: [Errno 2] No such file or directory: 'tests/fixtures/data.json'\n=== 1 failed in 0.10s ===";
  expect(classifyOutput(stdout, ["data.json"], "/tmp/tree", pythonCheck)).toMatchObject({
    failsWithoutChange: "unchecked",
  });
});

it("still attributes a missing file the revert removed, named relatively or by its tree path", () => {
  expect(
    classifyOutput(
      "FileNotFoundError: [Errno 2] No such file or directory: 'config/app.json'\nFAILED (errors=1)",
      ["config/app.json"],
      "/tmp/tree",
      pythonCheck,
    ),
  ).toMatchObject({ failsWithoutChange: true, signal: "structural" });
  expect(
    classifyOutput(
      "FileNotFoundError: [Errno 2] No such file or directory: '/tmp/tree/config/app.json'\nFAILED (errors=1)",
      ["config/app.json"],
      "/tmp/tree",
      pythonCheck,
    ),
  ).toMatchObject({ failsWithoutChange: true, signal: "structural" });
});

it("keeps a vitest assertion whose test title has brackets as a behavioral failure", () => {
  const stdout =
    ' FAIL  cases.test.mjs > adds [1, 2]\nAssertionError: expected 2 to be 3 // Object.is equality\n ❯ cases.test.mjs:3:33\n      3| it("adds", () => expect(add(1, 2)).toBe(3));';
  expect(classifyOutput(stdout, ["value.mjs"])).toMatchObject({
    failsWithoutChange: true,
    signal: "behavioral",
  });
});

// Real outputs of reverted runs that fail to collect or load their tests (paths under /tmp/tree).
const REAL_NODE_COLLECT =
  "node:internal/modules/esm/resolve:272\n    throw new ERR_MODULE_NOT_FOUND(\n          ^\n\nError [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/tree/src/r22b-newmod.mjs' imported from /tmp/tree/r22bnode/collect.test.mjs\n    at finalizeResolution (node:internal/modules/esm/resolve:272:11)\n    at moduleResolve (node:internal/modules/esm/resolve:879:10)\n    at defaultResolve (node:internal/modules/esm/resolve:1006:11)\n    at #cachedDefaultResolve (node:internal/modules/esm/loader:708:20)\n    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:728:38)\n    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:766:56)\n    at #resolve (node:internal/modules/esm/loader:690:17)\n    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:610:35)\n    at ModuleJob.syncLink (node:internal/modules/esm/module_job:277:33)\n    at ModuleJob.link (node:internal/modules/esm/module_job:389:17) {\n  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///tmp/tree/src/r22b-newmod.mjs'\n}\n\nNode.js v26.7.0\n✖ r22bnode/collect.test.mjs (36.578977ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 44.514581\n\n✖ failing tests:\n\ntest at r22bnode/collect.test.mjs:1:1\n✖ r22bnode/collect.test.mjs (36.578977ms)\n  'test failed'\n";
const REAL_NODE_TOPLEVEL =
  "file:///tmp/tree/r22bnode/toplevel.test.mjs:4\nif (!globalThis.__fixtureOk) throw new Error(\"fixture data.json is missing\");\n                                   ^\n\nError: fixture data.json is missing\n    at file:///tmp/tree/r22bnode/toplevel.test.mjs:4:36\n    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)\n    at async node:internal/modules/esm/loader:650:26\n    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n\nNode.js v26.7.0\n✖ r22bnode/toplevel.test.mjs (37.937439ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 45.494452\n\n✖ failing tests:\n\ntest at r22bnode/toplevel.test.mjs:1:1\n✖ r22bnode/toplevel.test.mjs (37.937439ms)\n  'test failed'\n";
const REAL_PYTEST_COLLECT =
  "\n==================================== ERRORS ====================================\n___________________ ERROR collecting r22bpy/test_collect.py ____________________\nImportError while importing test module '/tmp/tree/r22bpy/test_collect.py'.\nHint: make sure your test modules/packages have valid Python names.\nTraceback:\n/usr/lib/python3.10/importlib/__init__.py:126: in import_module\n    return _bootstrap._gcd_import(name[level:], package, level)\nr22bpy/test_collect.py:1: in <module>\n    from src.r22b_newmod import value\nE   ModuleNotFoundError: No module named 'src.r22b_newmod'\n=========================== short test summary info ============================\nERROR r22bpy/test_collect.py\n!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!\n1 error in 0.12s\n";
const REAL_VITEST_COLLECT =
  'Lockfile is up to date, resolution step is skipped\nAlready up to date\n\nDone in 923ms using pnpm v11.3.0\n\n RUN  v3.2.7 /tmp/tree\n\ndist/cli.js is missing: run `pnpm build` before tests that execute the CLI.\n\n⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  tests/r22b-collect.test.ts [ tests/r22b-collect.test.ts ]\nError: Cannot find module \'../src/r22b-newmod.js\' imported from \'/tmp/tree/tests/r22b-collect.test.ts\'\n ❯ tests/r22b-collect.test.ts:2:1\n      1| import { expect, it } from "vitest";\n      2| import { newmod } from "../src/r22b-newmod.js";\n       | ^\n      3| it("uses the new module", () => expect(newmod).toBe(2));\n      4| \n\nCaused by: Error: Failed to load url ../src/r22b-newmod.js (resolved id: ../src/r22b-newmod.js) in /tmp/tree/tests/r22b-collect.test.ts. Does the file exist?\n ❯ loadAndTransform node_modules/.pnpm/vite@7.3.6_@types+node@22.20.1_jiti@2.7.0_yaml@2.9.0/node_modules/vite/dist/node/chunks/config.js:22739:33\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\n\n Test Files  1 failed (1)\n      Tests  no tests\n   Start at  03:12:43\n   Duration  302ms (transform 32ms, setup 5ms, collect 0ms, tests 0ms, environment 0ms, prepare 81ms)\n\n';

it("keeps a node collection failure that names the reverted module structural", () => {
  expect(classifyOutput(REAL_NODE_COLLECT, ["src/r22b-newmod.mjs"])).toMatchObject({
    failsWithoutChange: true,
    signal: "structural",
  });
});

it("reports a node top-level fixture failure under a relative file-level line as unchecked", () => {
  expect(
    classifyOutput(REAL_NODE_TOPLEVEL, ["r22bnode/toplevel.test.mjs"], "/tmp/tree", check),
  ).toMatchObject({ failsWithoutChange: "unchecked" });
});

it("keeps a pytest collection error for a reverted module structural and names its E line", () => {
  expect(
    classifyOutput(REAL_PYTEST_COLLECT, ["src/r22b_newmod.py"], "/tmp/tree", pythonCheck),
  ).toMatchObject({
    failsWithoutChange: true,
    signal: "structural",
    reason: "E   ModuleNotFoundError: No module named 'src.r22b_newmod'",
  });
  expect(
    classifyOutput(REAL_PYTEST_COLLECT, ["src/other.py"], "/tmp/tree", pythonCheck),
  ).toMatchObject({
    failsWithoutChange: "unchecked",
    reason:
      "reverted check environment/setup failure: E   ModuleNotFoundError: No module named 'src.r22b_newmod'",
  });
});

it("resolves a vitest specifier against its importer and maps .js to a reverted .ts module", () => {
  const vitestCheck: import("../../../../src/workflow/product/model.js").ProductCheck = {
    id: "C001",
    command: ["node_modules/.bin/vitest", "run", "tests/r22b-collect.test.ts"],
    files: [],
    outcomes: ["O001"],
    environment: "other" as const,
  };
  expect(
    classifyOutput(REAL_VITEST_COLLECT, ["src/r22b-newmod.ts"], "/tmp/tree", vitestCheck),
  ).toMatchObject({ failsWithoutChange: true, signal: "structural" });
  expect(
    classifyOutput(REAL_VITEST_COLLECT, ["src/other.ts"], "/tmp/tree", vitestCheck),
  ).toMatchObject({ failsWithoutChange: "unchecked" });
});

it("does not resolve a relative specifier when the importer is unknown", () => {
  const stdout = "Error: Cannot find module '../src/value.js'\n ❯ tests/regression.ts:2:1";
  expect(classifyOutput(stdout, ["src/value.ts"], "/tmp/tree", pythonCheck)).toMatchObject({
    failsWithoutChange: "unchecked",
  });
});

it("keeps a top-level node assertion under a relative file-level line as a behavioral failure", () => {
  const stdout =
    "node:internal/modules/run_main:107\n    triggerUncaughtException(\n    ^\n\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at file:///tmp/tree/test/value.test.mjs:1:84\n\nNode.js v26.7.0\n✖ test/value.test.mjs (33.5ms)\n";
  expect(classifyOutput(stdout, ["src/value.mjs"])).toMatchObject({
    failsWithoutChange: true,
    signal: "behavioral",
  });
});

it("never reports a vitest banner as the reason for a failed suite", () => {
  const stdout =
    "⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  tests/r22b-collect.test.ts [ tests/r22b-collect.test.ts ]\nError: Cannot find module '../src/value.js' imported from '/tmp/tree/tests/r22b-collect.test.ts'\n ❯ tests/r22b-collect.test.ts:2:1";
  const result = classifyOutput(stdout, ["src/value.ts"]);
  expect(result.reason).not.toContain("⎯");
});
