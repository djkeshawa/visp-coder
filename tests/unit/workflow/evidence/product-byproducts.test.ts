import { afterEach, expect, it, vi } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { isDerivedByproduct } from "../../../../src/workflow/product/byproducts.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import { productInputWarnings } from "../../../../src/workflow/product/input-warnings.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import { checkProductScope } from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import {
  productSourceDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function fixture() {
  const setup = await productWorkspace();
  workspaces.push(setup.workspace);
  return setup;
}
const withScope = (brief: ProductBrief, scope: Partial<ProductBrief["slices"][0]["scope"]>) => ({
  ...brief,
  slices: brief.slices.map((slice) => ({ ...slice, scope: { ...slice.scope, ...scope } })),
});

it.each([
  "__pycache__/x.cpython-312.pyc",
  "src/pkg/__pycache__/x.pyc",
  "tests/.pytest_cache/v/cache/nodeids",
  ".mypy_cache/3.12/x.json",
  "a/.ruff_cache/x",
  ".coverage",
  "sub/.DS_Store",
  "Thumbs.db",
  ".playwright-mcp/console.log",
  "pkg/.idea/workspace.xml",
  ".claude/settings.local.json",
  "coverage/lcov.info",
  "htmlcov/index.html",
  ".nyc_output/out.json",
  "test-results/a.json",
  "playwright-report/index.html",
  "logs/app.txt",
  "log/app.txt",
  "server.log",
])("treats %s as a derived byproduct", (path) => {
  expect(isDerivedByproduct(path)).toBe(true);
});

it.each([
  "src/coverage/a.py",
  "lib/server.log",
  "src/logs/app.txt",
  "src/value.mjs",
  "main.py",
  "index.html",
  "dist/bundle.js",
  "build/out.js",
  "data/app.db",
  "data/app.sqlite",
  "logs/helper.js",
  "pkg/util.pyc",
  "src/x.pyo",
  "__pycache__/evil.py",
  "src/__pycache__/native.so",
  ".pytest_cache/conftest.py",
  ".mypy_cache/plugin.py",
  ".ruff_cache/x.js",
  ".idea/run.js",
  "pkg/.idea/tool.sh",
  ".playwright-mcp/x.js",
  "log/serve.py",
  ".claude/settings.json",
  "notes.txt",
])("keeps %s as product", (path) => {
  expect(isDerivedByproduct(path)).toBe(false);
});

it("leaves untracked tool output out of the subject", async () => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  const before = value(await productSourceDigest(state, brief));
  await workspace.write("__pycache__/x.cpython-312.pyc", "bytecode");
  await workspace.write("server.log", "listening");
  await workspace.write("coverage/lcov.info", "SF:src/value.mjs");
  await workspace.write("test-results/a.json", "{}");
  const snapshot = value(await productSourceSnapshot(state, brief));
  expect(
    Object.keys(snapshot).filter((path) => /pyc|log|coverage|test-results/.test(path)),
  ).toEqual([]);
  expect(value(await productSourceDigest(state, brief))).toBe(before);
});

it("still counts the same names when they are not at the root or are product code", async () => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  const before = value(await productSourceDigest(state, brief));
  for (const path of [
    "src/coverage/a.py",
    "lib/server.log",
    "logs/helper.mjs",
    "pkg/util.pyc",
    "__pycache__/evil.py",
    ".idea/run.js",
    ".playwright-mcp/x.js",
  ]) {
    await workspace.write(path, "x");
    const digest = value(await productSourceDigest(state, brief));
    expect(digest, path).not.toBe(before);
    expect(Object.keys(value(await productSourceSnapshot(state, brief)))).toContain(path);
    await workspace.write(path, "changed");
    expect(value(await productSourceDigest(state, brief)), path).not.toBe(digest);
  }
});

it("skips generated report files, so a check that reads one must declare it", async () => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  await workspace.write("coverage/report.js", "generated");
  expect(Object.keys(value(await productSourceSnapshot(state, brief)))).not.toContain(
    "coverage/report.js",
  );
  const declared = {
    ...brief,
    checks: brief.checks.map((check) => ({
      ...check,
      files: [...check.files, "coverage/report.js"],
    })),
  };
  expect(Object.keys(value(await productSourceSnapshot(state, declared)))).toContain(
    "coverage/report.js",
  );
});

it("hashes a tracked file with a byproduct name as before", async () => {
  const { workspace, brief } = await fixture();
  await workspace.write("tracked.log", "one");
  workspace.git("add", "tracked.log");
  workspace.git("commit", "--no-verify", "-qm", "track a log");
  const state = await workspace.state();
  const before = value(await productSourceDigest(state, brief));
  expect(Object.keys(value(await productSourceSnapshot(state, brief)))).toContain("tracked.log");
  await workspace.write("tracked.log", "two");
  expect(value(await productSourceDigest(state, brief))).not.toBe(before);
});

type Declared = {
  checkFiles?: string[];
  allowed?: string[];
  expected?: string[];
  forbidden?: string[];
};
it.each<[string, Declared]>([
  ["a declared check input", { checkFiles: ["server.log"] }],
  ["a check input pattern", { checkFiles: ["*.log"] }],
  ["an allowed scope pattern", { allowed: ["server.log"] }],
  ["an expected scope pattern", { expected: ["server.log"] }],
  ["a forbidden scope pattern", { forbidden: ["server.log"] }],
])("never skips a path matching %s", async (_name, declared) => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  const slice = brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const declaredBrief: ProductBrief = {
    ...brief,
    checks: brief.checks.map((check) => ({
      ...check,
      files: [...check.files, ...(declared.checkFiles ?? [])],
    })),
    slices: [
      {
        ...slice,
        scope: {
          allowed: [...slice.scope.allowed, ...(declared.allowed ?? [])],
          expected: [...slice.scope.expected, ...(declared.expected ?? [])],
          forbidden: [...slice.scope.forbidden, ...(declared.forbidden ?? [])],
        },
      },
    ],
  };
  await workspace.write("server.log", "listening");
  const before = value(await productSourceDigest(state, declaredBrief));
  expect(Object.keys(value(await productSourceSnapshot(state, declaredBrief)))).toContain(
    "server.log",
  );
  await workspace.write("server.log", "changed");
  expect(value(await productSourceDigest(state, declaredBrief))).not.toBe(before);
});

it("skips no path a configured blocked pattern names", async () => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  await workspace.write("logs/app.txt", "line");
  const blocking = {
    ...state,
    config: {
      ...state.config,
      workflow: {
        ...state.config.workflow,
        blockedPaths: [...state.config.workflow.blockedPaths, "logs"],
      },
    },
  };
  expect(Object.keys(value(await productSourceSnapshot(state, brief)))).not.toContain(
    "logs/app.txt",
  );
  expect(Object.keys(value(await productSourceSnapshot(blocking, brief)))).toContain(
    "logs/app.txt",
  );
});

it("does not warn about untracked tool output but warns about other untracked files", async () => {
  const { workspace, brief } = await fixture();
  await workspace.write("server.log", "listening");
  await workspace.write("__pycache__/x.pyc", "bytecode");
  expect(await productInputWarnings(await workspace.state(), brief)).toEqual([]);
  await workspace.write("notes.txt", "mine");
  expect(await productInputWarnings(await workspace.state(), brief)).toEqual([
    expect.stringContaining("Untracked file notes.txt is outside every slice scope"),
  ]);
});

it("no longer reports untracked tool output as a scope violation, but still reports product files", async () => {
  const { workspace } = await fixture();
  const state = await workspace.state();
  value(await runProductWork(state, { task: "T001" }));
  const record = value(await readProductRecord(state));
  const slice = record.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  await workspace.write("server.log", "listening");
  await workspace.write("__pycache__/x.pyc", "bytecode");
  expect(await checkProductScope(state, record, slice)).toMatchObject({ ok: true });
  await workspace.write("src/coverage/a.py", "print(1)");
  expect(await checkProductScope(state, record, slice)).toMatchObject({
    ok: false,
    error: { code: "SCOPE_VIOLATION", details: { outside: ["src/coverage/a.py"] } },
  });
});

it("reports a forbidden write into a directory that looks like output", async () => {
  const { workspace, brief } = await fixture();
  const state = await workspace.state();
  const forbidden = withScope(brief, { forbidden: ["coverage/**"] });
  value(await updateProductBrief(state, { brief: forbidden, reason: "Forbid coverage output" }));
  value(await runProductWork(await workspace.state(), { task: "T001" }));
  const record = value(await readProductRecord(await workspace.state()));
  const slice = record.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  await workspace.write("coverage/lcov.info", "SF:src/value.mjs");
  expect(await checkProductScope(await workspace.state(), record, slice)).toMatchObject({
    ok: false,
    error: { code: "SCOPE_VIOLATION", details: { forbidden: ["coverage/lcov.info"] } },
  });
});

it("never lists node_modules for a glob that starts with a wildcard", async () => {
  const { workspace, brief } = await fixture();
  await workspace.write(".gitignore", "node_modules/\n");
  await workspace.write("node_modules/pkg/a.test.mjs", "vendored");
  await workspace.write("test/b.test.mjs", "own");
  const state = await workspace.state();
  const listed = vi.spyOn(state.files, "listEntries");
  const snapshot = value(
    await productSourceSnapshot(state, {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, files: ["**/*.test.mjs"] })),
    }),
  );
  expect(Object.keys(snapshot)).toContain("test/b.test.mjs");
  expect(Object.keys(snapshot)).not.toContain("node_modules/pkg/a.test.mjs");
  expect(
    listed.mock.calls.map(([path]) => path).filter((path) => /node_modules/.test(path)),
  ).toEqual([]);
});

it("still reaches a tool directory that a pattern names", async () => {
  const { workspace, brief } = await fixture();
  await workspace.write(".gitignore", "node_modules/\npackages/*/dist/\n");
  await workspace.write("node_modules/pkg/a.test.mjs", "vendored");
  await workspace.write("packages/a/dist/out.mjs", "built");
  const state = await workspace.state();
  const snapshot = (pattern: string) =>
    productSourceSnapshot(state, {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, files: [pattern] })),
    });
  expect(Object.keys(value(await snapshot("node_modules/pkg/**")))).toContain(
    "node_modules/pkg/a.test.mjs",
  );
  expect(Object.keys(value(await snapshot("packages/*/dist/out.mjs")))).toContain(
    "packages/a/dist/out.mjs",
  );
});
