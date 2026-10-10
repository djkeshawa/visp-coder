import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { err, ok } from "../../src/core/result.js";
import { classifyFlip } from "../../src/workflow/product/flip-check.js";
import { inFlipTree, recoverFlipBaseline } from "../../src/workflow/product/flip-tree.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../src/workflow/product/index.js";
import { reviewCheckResult } from "../../src/workflow/product/review-check-context.js";
import { readProductAuthorizationBaseline } from "../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../src/workflow/product/subject.js";
import { productWorkspace } from "./support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
async function fixture(
  files: Record<string, string>,
  command: string[],
  validation: string[] = ["src/**", "test/**", "tests/**"],
  timeoutMs = 10000,
  beforeWork?: (
    workspace: Awaited<ReturnType<typeof productWorkspace>>["workspace"],
  ) => Promise<void>,
) {
  const p = await productWorkspace();
  projects.push(p);
  const w = p.workspace;
  for (const [path, content] of Object.entries(files)) await w.write(path, content);
  await beforeWork?.(w);
  w.commit("review baseline");
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...p.brief,
      checks: [{ ...p.brief.checks[0], command, files: validation, timeoutMs }],
      slices: [{ ...p.brief.slices[0], scope: { allowed: ["**"], expected: [], forbidden: [] } }],
    },
    reason: "independent review probe",
  });
  expect(updated.ok).toBe(true);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write("src/value.mjs", "export const value = 2;\n");
  return w;
}
async function verify(w: Awaited<ReturnType<typeof productWorkspace>>["workspace"]) {
  const r = await runProductVerify(await w.state(), { task: "T001" });
  if (!r.ok) throw new Error(r.error.message);
  const execution = r.value.executions[0];
  if (!execution) throw new Error("missing execution");
  return execution;
}
it("follows Python from-package imports to revert production helpers", async () => {
  const w = await fixture(
    {
      "src/app.py": "from tests import helper\nvalue = helper.value\n",
      "tests/__init__.py": "",
      "tests/helper.py": "value = 1\n",
      "tests/regression.py":
        "import sys\nsys.path.insert(0, '.')\nfrom src.app import value\nassert value == 2\n",
    },
    ["python3", "tests/regression.py"],
  );
  await w.write("tests/helper.py", "value = 2\n");
  const receipt = await verify(w);
  console.info("PYTHON_FROM_PACKAGE", JSON.stringify(receipt.flip));
  expect(receipt.status).toBe("passed");
  expect(receipt.flip?.revertedFiles).toContain("tests/helper.py");
});
it("unittest fixture setup failure is classified as unchecked", () => {
  const check: import("../../src/workflow/product/model.js").ProductCheck = {
    id: "C001",
    command: ["python3", "-m", "unittest"],
    files: [],
    outcomes: ["O001"],
    environment: "other",
  };
  const stdout =
    "ERROR: test_value (test_regression.Regression.test_value)\nTraceback (most recent call last):\n  File 'tests/test_regression.py', line 5, in setUp\n    open('fixtures/data.json')\nFileNotFoundError: [Errno 2] No such file or directory: 'fixtures/data.json'\nFAILED (errors=1)";
  const result = classifyFlip(
    ok({ command: "python3", exitCode: 1, stdout, stderr: "", durationMs: 1, timedOut: false }),
    check,
    ["src/value.py"],
    [],
    "/tmp/tree",
    (x) => x,
  );
  console.info("UNITTEST_SETUP", JSON.stringify(result));
  expect(result.failsWithoutChange).toBe("unchecked");
  expect(result.reason).toContain("FileNotFoundError");
});
it("reverts a standalone production entry despite verifierFiles", async () => {
  const w = await fixture(
    {
      "main.mjs": "export const value=1;\n",
      "test/main.test.mjs":
        "import assert from 'node:assert/strict'; import {value} from '../main.mjs'; assert.equal(value,2);\n",
    },
    [process.execPath, "test/main.test.mjs"],
    ["main.mjs", "test/**"],
  );
  const loaded = await readProductRecord(await w.state(), {});
  if (!loaded.ok) throw new Error("record");
  const updated = await updateProductBrief(await w.state(), {
    brief: {
      ...loaded.value.brief,
      checks: [
        { ...loaded.value.brief.checks[0], verifierFiles: ["main.mjs", "test/main.test.mjs"] },
      ],
    },
    reason: "worker labels entry as verifier",
  });
  expect(updated.ok).toBe(true);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write("main.mjs", "export const value=2;\n");
  const receipt = await verify(w);
  console.info("VERIFIER_ENTRY", JSON.stringify(receipt.flip));
  expect(receipt.flip).toBeDefined();
  expect(receipt.flip?.revertedFiles).toContain("main.mjs");
});
it.each(["success", "failure", "timeout", "cancellation"] as const)(
  "isolates comparison writes on %s",
  async (outcome) => {
    const tail = {
      success: "",
      failure: "throw new Error('AssertionError: regression');",
      timeout: "await new Promise(r=>setTimeout(r,30000));",
      cancellation: "await new Promise(r=>setTimeout(r,30000));",
    }[outcome];
    const script =
      "import {value} from '../src/value.mjs'; import {writeFileSync} from 'node:fs'; if(value===1) { writeFileSync('node_modules/cache/marker','baseline run'); " +
      tail +
      " }\n";
    const w = await fixture(
      { ".gitignore": "node_modules/\n", "test/write.test.mjs": script },
      [process.execPath, "test/write.test.mjs"],
      undefined,
      outcome === "timeout" ? 1000 : 10000,
    );
    await w.write("node_modules/cache/marker", "original");
    const controller = new AbortController();
    if (outcome === "cancellation") {
      const exec = await import("../../src/core/exec.js");
      const original = exec.run;
      vi.spyOn(exec, "run").mockImplementation((file, args, options) => {
        if (options.cwd.includes("visp-product-flip-") && file === process.execPath)
          setTimeout(() => controller.abort(), 200);
        return original(file, args, options);
      });
    }
    const result = await runProductVerify(await w.state(), {
      task: "T001",
      signal: controller.signal,
    });
    if (outcome === "cancellation")
      expect(result).toMatchObject({ ok: false, error: { details: { cancelled: true } } });
    else {
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.value.executions[0]?.flip?.failsWithoutChange).toBe(
          outcome === "success" ? false : outcome === "failure" ? true : "unchecked",
        );
    }
    expect(await readFile(join(w.root, "node_modules/cache/marker"), "utf8")).toBe("original");
    expect(w.git("worktree", "list").trim().split("\n")).toHaveLength(1);
  },
);
it("cleanup failure still removes temp disk tree", async () => {
  const w = await fixture({}, [process.execPath, "--test", "test/value.test.mjs"]);
  const ws = await w.state();
  const loaded = await readProductRecord(ws, {});
  if (!loaded.ok) throw new Error("record");
  const a = await readProductAuthorizationBaseline(ws, loaded.value);
  if (!a.ok || !a.value) throw new Error("auth");
  const baseline = await recoverFlipBaseline(ws, a.value);
  const snapshot = await productSourceSnapshot(ws, loaded.value.brief);
  if (!snapshot.ok) throw new Error("snapshot");
  const exec = await import("../../src/core/exec.js");
  const original = exec.run;
  let disk = "";
  vi.spyOn(exec, "run").mockImplementation((file, args, options) => {
    if (file === "git" && args[0] === "worktree" && args[1] === "remove")
      return Promise.resolve(err({ code: "COMMAND_FAILED", message: "simulated cleanup failure" }));
    return original(file, args, options);
  });
  await expect(
    inFlipTree(
      ws,
      a.value,
      baseline,
      new Set(["test/value.test.mjs"]),
      snapshot.value,
      async (directory) => {
        disk = directory;
        return true;
      },
    ),
  ).rejects.toThrow("could not clean up");
  const exists = await readdir(disk).then(
    () => true,
    () => false,
  );
  console.info("CLEANUP_FAILURE_TEMP_EXISTS", exists, disk);
  expect(vi.mocked(exec.run).mock.calls.filter(([, args]) => args.includes("prune"))).toHaveLength(
    0,
  );
  expect(
    vi
      .mocked(exec.run)
      .mock.calls.filter(([, args]) => args[0] === "worktree" && args[1] === "remove").length,
  ).toBeGreaterThan(1);
  vi.restoreAllMocks();
  w.git("worktree", "remove", "--force", "--force", disk);
  await rm(join(disk, ".."), { recursive: true, force: true });
  expect(exists).toBe(false);
});
it("real unittest setup cannot read an external fixture on baseline", async () => {
  const w = await fixture(
    {
      "src/value.py": "with open('fixtures/data.json') as f:\n value = int(f.read())\n",
      "tests/setup_check.py":
        "import sys, unittest\nsys.path.insert(0, '.')\nclass Regression(unittest.TestCase):\n def setUp(self):\n  from src.value import value\n  self.value = value\n def test_value(self):\n  self.assertEqual(self.value, 2)\nunittest.main()\n",
    },
    ["python3", "tests/setup_check.py"],
  );
  await w.write("src/value.py", "value = 2\n");
  const receipt = await verify(w);
  console.info("REAL_SETUP_ERROR", JSON.stringify(receipt));
  expect(receipt.status).toBe("passed");
  expect(receipt.flip?.failsWithoutChange).toBe("unchecked");
});
it("restores renamed and deleted implementation while keeping renamed validation", async () => {
  const w = await fixture(
    {
      "src/old.mjs": "export const value=1;\n",
      "test/check_old.test.mjs":
        "import assert from 'node:assert/strict'; import {value} from '../src/old.mjs'; assert.equal(value,2);\n",
    },
    [process.execPath, "--test"],
  );
  await rm(join(w.root, "src/old.mjs"));
  await w.write("src/new.mjs", "export const value=2;\n");
  await rm(join(w.root, "test/check_old.test.mjs"));
  await w.write(
    "test/check_new.test.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/new.mjs'; assert.equal(value,2);\n",
  );
  const receipt = await verify(w);
  console.info("RENAMES", JSON.stringify(receipt.flip));
  expect(receipt.status).toBe("passed");
  expect(receipt.flip?.failsWithoutChange).toBe(true);
  expect(receipt.flip?.revertedFiles).toEqual(["src/new.mjs", "src/old.mjs", "src/value.mjs"]);
});
it("starts both runs from the same environment counter", async () => {
  const w = await fixture(
    {
      ".gitignore": "node_modules/\n",
      "test/counter.test.mjs":
        "import {readFileSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict'; const p='node_modules/cache/counter'; const value=Number(readFileSync(p,'utf8')); writeFileSync(p,String(value+1)); assert.equal(value,0);\n",
    },
    [process.execPath, "test/counter.test.mjs"],
  );
  await w.write("node_modules/cache/counter", "0");
  const receipt = await verify(w);
  console.info(
    "NON_IDEMPOTENT",
    JSON.stringify({
      status: receipt.status,
      flip: receipt.flip,
      counter: await readFile(join(w.root, "node_modules/cache/counter"), "utf8"),
    }),
  );
  expect(receipt.status).toBe("passed");
  expect(receipt.flip?.failsWithoutChange).toBe(false);
  expect(await readFile(join(w.root, "node_modules/cache/counter"), "utf8")).toBe("1");
});
it("rebinds workspace package links to load baseline implementation", async () => {
  const w = await fixture(
    {
      ".gitignore": "node_modules/\n",
      "src/pkg/package.json": '{"name":"fixture-module","type":"module","exports":"./index.mjs"}\n',
      "src/pkg/index.mjs": "export const value=1;\n",
      "test/package.test.mjs":
        "import assert from 'node:assert/strict'; import {value} from 'fixture-module'; assert.equal(value,2);\n",
    },
    [process.execPath, "test/package.test.mjs"],
  );
  await w.write("src/pkg/index.mjs", "export const value=2;\n");
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(w.root, "node_modules"), { recursive: true });
  await fs.symlink("../src/pkg", join(w.root, "node_modules/fixture-module"));
  const receipt = await verify(w);
  console.info("WORKSPACE_PACKAGE", JSON.stringify(receipt.flip));
  expect(receipt.status).toBe("passed");
  expect(receipt.flip?.revertedFiles).toContain("src/pkg/index.mjs");
  expect(receipt.flip?.failsWithoutChange).toBe(true);
});

it.runIf(!!process.env.VISP_FLIP_DJANGO_REFERENCE)(
  "flips the actual Django functional module with a pure-Python regression",
  async () => {
    const path = "django/utils/functional.py";
    const original = await readFile(
      join(process.env.VISP_FLIP_DJANGO_REFERENCE as string, path),
      "utf8",
    );
    const w = await fixture(
      {
        [path]: original,
        "tests/partition.py":
          "import importlib.util, unittest\ns=importlib.util.spec_from_file_location('functional','django/utils/functional.py')\nm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)\nclass Regression(unittest.TestCase):\n def test_truthy_predicate(self):\n  self.assertEqual(m.partition(lambda x: 'yes' if x > 1 else '', [0,1,2]), ([0,1],[2]))\nunittest.main()\n",
      },
      ["python3", "tests/partition.py"],
      [path, "tests/**"],
    );
    await w.write(
      path,
      original.replace(
        "results[predicate(item)].append(item)",
        "results[bool(predicate(item))].append(item)",
      ),
    );
    const receipt = await verify(w);
    expect(receipt).toMatchObject({
      status: "passed",
      flip: {
        failsWithoutChange: true,
        signal: "behavioral",
        revertedFiles: expect.arrayContaining([path]),
      },
    });
    console.info(
      `Django module: original=${receipt.durationMs}ms, extra=${receipt.flipDurationMs}ms`,
    );
  },
);

it("rebinds an absolute virtualenv command and its editable installation", async () => {
  const w = await fixture(
    {
      ".gitignore": ".venv/\n",
      "src/value.py": "value=1\n",
      "tests/editable.py": "import value\nassert value.value == 2\n",
    },
    ["python3", "tests/editable.py"],
  );
  const exec = await import("../../src/core/exec.js");
  const created = await exec.run("python3", ["-m", "venv", "--without-pip", ".venv"], {
    cwd: w.root,
    timeoutMs: 10000,
  });
  expect(created).toMatchObject({ ok: true, value: { exitCode: 0 } });
  const version = await exec.run(
    ".venv/bin/python",
    ["-c", "import sys;print(f'python{sys.version_info.major}.{sys.version_info.minor}')"],
    { cwd: w.root, timeoutMs: 10000 },
  );
  if (!version.ok) throw new Error(version.error.message);
  await w.write(
    `.venv/lib/${version.value.stdout.trim()}/site-packages/editable.pth`,
    `${join(w.root, "src")}\n`,
  );
  const loaded = await readProductRecord(await w.state(), {});
  if (!loaded.ok) throw new Error(loaded.error.message);
  expect(
    (
      await updateProductBrief(await w.state(), {
        brief: {
          ...loaded.value.brief,
          checks: [
            {
              ...loaded.value.brief.checks[0],
              command: [join(w.root, ".venv/bin/python"), "tests/editable.py"],
            },
          ],
        },
        reason: "Use project virtualenv",
      })
    ).ok,
  ).toBe(true);
  expect((await runProductWork(await w.state(), { task: "T001" })).ok).toBe(true);
  await w.write("src/value.py", "value=2\n");
  expect(await verify(w)).toMatchObject({
    status: "passed",
    flip: {
      failsWithoutChange: true,
      signal: "behavioral",
      revertedFiles: expect.arrayContaining(["src/value.py"]),
    },
  });
});

it("loads reverted production bytes when the environment root aliases tracked packages", async () => {
  const w = await fixture(
    {
      ".gitignore": "node_modules\n",
      "packages/fixture-module/package.json": '{"type":"module","exports":"./index.mjs"}',
      "packages/fixture-module/index.mjs": "export const value=1;\n",
      "test/linked-root.test.mjs":
        "import assert from 'node:assert/strict';import {value} from 'fixture-module';assert.equal(value,2);\n",
    },
    [process.execPath, "test/linked-root.test.mjs"],
    ["src/**", "packages/**", "test/**"],
  );
  const fs = await import("node:fs/promises");
  await fs.symlink("packages", join(w.root, "node_modules"));
  await w.write("packages/fixture-module/index.mjs", "export const value=2;\n");
  expect(await verify(w)).toMatchObject({
    status: "passed",
    flip: {
      failsWithoutChange: true,
      signal: "behavioral",
      revertedFiles: expect.arrayContaining(["packages/fixture-module/index.mjs"]),
    },
  });
  expect(await readFile(join(w.root, "node_modules/fixture-module/index.mjs"), "utf8")).toBe(
    "export const value=2;\n",
  );
});

it("rebinds recorded absolute project links to the comparison's reverted bytes", async () => {
  const w = await fixture(
    {
      "test/absolute.test.mjs":
        "import assert from 'node:assert/strict';import {value} from '../src/linked.mjs';assert.equal(value,2);\n",
    },
    [process.execPath, "test/absolute.test.mjs"],
    undefined,
    10000,
    async (w) => {
      const fs = await import("node:fs/promises");
      await fs.symlink(join(w.root, "src/value.mjs"), join(w.root, "src/linked.mjs"));
    },
  );
  expect(await verify(w)).toMatchObject({
    status: "passed",
    flip: { failsWithoutChange: true, signal: "behavioral", revertedFiles: ["src/value.mjs"] },
  });
  expect(await readFile(join(w.root, "src/linked.mjs"), "utf8")).toBe("export const value = 2;\n");
});

it("keeps wall-clock flip timing out of the identity of an executed check, but shows it", () => {
  const execution = (flipDurationMs: number) =>
    ({
      id: "E1",
      check: "C001",
      status: "passed",
      exitCode: 0,
      command: "node --test",
      provenance: "supervisor-executed",
      assertions: "agent-reported",
      output: "ok",
      flipDurationMs,
      flip: {
        failsWithoutChange: true,
        revertedFiles: ["src/value.mjs"],
        preservedValidationFiles: [],
        commands: [],
      },
    }) as unknown as Parameters<typeof reviewCheckResult>[0];
  expect(reviewCheckResult(execution(5), undefined, { timing: false })).toBe(
    reviewCheckResult(execution(9), undefined, { timing: false }),
  );
  expect(reviewCheckResult(execution(5))).toContain("Flip check extra time: 5 ms");
  expect(reviewCheckResult(execution(5))).not.toBe(reviewCheckResult(execution(9)));
});
