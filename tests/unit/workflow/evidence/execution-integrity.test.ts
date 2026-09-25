import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function prepare(commands: [string, ...string[]][], extraAllowed: string[] = []) {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  value(
    await updateProductBrief(await workspace.state(), {
      reason: "Set concrete execution regression checks",
      brief: {
        ...fixture.brief,
        checks: commands.map((command, index) => ({
          id: `C${index}`,
          command,
          outcomes: ["O001"],
          files: [],
          environment: "node",
        })),
        slices: fixture.brief.slices.map((slice) => ({
          ...slice,
          scope: {
            ...slice.scope,
            allowed: [...slice.scope.allowed, ".gitignore", ...extraAllowed],
          },
          checks: commands.map((_, index) => `C${index}`),
        })),
      },
    }),
  );
  value(await runProductWork(await workspace.state()));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  return workspace;
}
it("executes both distinct argv checks and retains each actual result", async () => {
  const workspace = await prepare([
    [process.execPath, "-e", "process.exit(process.argv.length === 2 ? 0 : 1)", "a b"],
    [process.execPath, "-e", "process.exit(process.argv.length === 2 ? 0 : 1)", "a", "b"],
  ]);
  const result = value(await runProductVerify(await workspace.state()));
  expect(result.executions).toEqual([
    expect.objectContaining({ check: "C0", status: "passed" }),
    expect.objectContaining({ check: "C1", status: "failed" }),
  ]);
  expect(result.passed).toBe(false);
});
it.each(["src/value.mjs", "outside.txt", ".visp/policy.json"])(
  "does not certify a passing command that changes %s",
  async (target) => {
    const workspace = await prepare([
      [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'BROKEN')`,
      ],
    ]);
    const result = value(await runProductVerify(await workspace.state()));
    expect(result.executions[0]?.status).toBe("passed");
    expect(await readFile(join(workspace.root, target), "utf8")).toBe("BROKEN");
    expect(result.passed).toBe(false);
    expect(result.gaps.join(" ")).toContain("Product changed while checks ran");
    expect(result.gaps.join(" ")).toContain(
      target.startsWith(".visp/") ? "Control, runtime or environment inputs changed" : target,
    );
  },
);
it("identifies generated cache files without certifying the changed product", async () => {
  const workspace = await prepare([
    [
      process.execPath,
      "-e",
      "const fs=require('node:fs');fs.mkdirSync('__pycache__');fs.writeFileSync('__pycache__/server.pyc','cache')",
    ],
  ]);
  const result = value(await runProductVerify(await workspace.state()));
  expect(result.executions[0]?.status).toBe("passed");
  expect(result.passed).toBe(false);
  expect(result.gaps.join(" ")).toContain("__pycache__/server.pyc");
  expect(result.gaps.join(" ")).toContain("py_compile");
  expect(result.gaps.join(" ")).toContain("even with -B");
});

it("keeps explicit Python compilation stable with an intentional output policy and still tracks source", async () => {
  const workspace = await prepare(
    [
      ["python3", "-B", "-m", "py_compile", "value.py"],
      [process.execPath, "--test", "test/value.test.mjs"],
    ],
    ["value.py"],
  );
  await workspace.write("value.py", "VALUE = 2\n");
  const state = await workspace.state();
  const ignored = value(await state.files.readTextIfExists(".gitignore")) ?? "";
  await workspace.write(".gitignore", `${ignored}\n__pycache__/\n`);
  workspace.commit("declare generated Python output before checking");
  const first = value(await runProductVerify(await workspace.state()));
  const second = value(await runProductVerify(await workspace.state()));
  expect(first.passed).toBe(true);
  expect(second.passed).toBe(true);
  expect(second.subjectDigest).toBe(first.subjectDigest);
  await workspace.write("value.py", "VALUE = 3\n");
  const changed = value(await runProductVerify(await workspace.state()));
  expect(changed.subjectDigest).not.toBe(first.subjectDigest);
});
it("keeps a stable product current when a check writes only undeclared ignored outputs and bookkeeping", async () => {
  const workspace = await prepare([
    [
      process.execPath,
      "-e",
      "const fs=require('node:fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/result','ok');fs.writeFileSync('.visp/validation-note','ok')",
    ],
  ]);
  const state = await workspace.state();
  const ignored = value(await state.files.readTextIfExists(".gitignore")) ?? "";
  await workspace.write(".gitignore", `${ignored}\ncoverage/\n`);
  // Commit the ignore policy before refreshing local authorization.
  workspace.commit("ignore generated coverage");
  const result = value(await runProductVerify(await workspace.state()));
  expect(result.passed).toBe(true);
});

it("runs Python checks without writing bytecode caches into the checked product", async () => {
  const inherited = process.env.PYTHONPYCACHEPREFIX;
  delete process.env.PYTHONPYCACHEPREFIX;
  try {
    const workspace = await prepare(
      [
        ["python3", "-c", "import sys; sys.path.insert(0, 'src'); import helper"],
        ["python3", "-m", "py_compile", "src/helper.py"],
      ],
      ["src/helper.py"],
    );
    await workspace.write("src/helper.py", "VALUE = 1\n");
    const result = value(await runProductVerify(await workspace.state()));
    expect(result.executions.map((execution) => execution.status)).toEqual(["passed", "passed"]);
    expect(result.gaps.join(" ")).not.toContain("Product changed while checks ran");
    const cache = await (await workspace.state()).files.readMetadata("src/__pycache__");
    expect(cache.ok && cache.value).toBeFalsy();
  } finally {
    if (inherited === undefined) delete process.env.PYTHONPYCACHEPREFIX;
    else process.env.PYTHONPYCACHEPREFIX = inherited;
  }
});

it("reports a sandbox that denies sockets as an environment failure with the recovery", async () => {
  const workspace = await prepare([
    [
      process.execPath,
      "-e",
      "console.error('  File \"/usr/lib/python3.10/socket.py\", line 232, in __init__\\nPermissionError: [Errno 1] Operation not permitted'); process.exit(1)",
    ],
  ]);
  const result = value(await runProductVerify(await workspace.state()));
  expect(result.executions[0]?.status).toBe("environment-failed");
  expect(result.executions[0]?.output).toContain("sandbox");
  expect(result.passed).toBe(false);
});
