import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { failedCheckOwners } from "../../../../src/workflow/product/corrections.js";
import { runProductDoneReviewed } from "../../../../src/workflow/product/done-review.js";
import {
  type IndependentTester,
  inlineTests,
} from "../../../../src/workflow/product/independent-tests.js";
import { runProductNext } from "../../../../src/workflow/product/index.js";
import {
  crashLine,
  crashNamesProductPath,
  crashSignature,
  type PinnedRun,
  persistentPinnedFailure,
  suiteCrashed,
} from "../../../../src/workflow/product/pinned-dispute-model.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
function state() {
  if (!workspace) throw new Error("no workspace");
  return workspace.state();
}
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
  workspace = undefined;
});

const NAME = "value is two";
const CRASH = "Error: the suite could not start";
const TRACE = `${CRASH}\n    at file:///tmp/run-1/value.test.mjs:9:7\n    at ModuleJob.run (node:internal/modules/esm/module_job:1:1)`;
const run = (over: Partial<PinnedRun>): PinnedRun => ({
  check: "PINNED_1",
  status: "failed",
  exitCode: 1,
  output: TRACE,
  subjectDigest: "s1",
  ...over,
});

it("tells a crash from a named failure and finds the same crash again", () => {
  expect(suiteCrashed(run({}), [NAME])).toBe(true);
  expect(suiteCrashed(run({ output: `FAIL: ${NAME}: no` }), [NAME])).toBe(false);
  expect(suiteCrashed(run({ status: "passed" }), [NAME])).toBe(false);
  expect(crashLine(TRACE)).toBe(CRASH);
  expect(crashLine("exit 1\n\nnothing else")).toBe("nothing else");
  expect(crashLine("")).toBeUndefined();
  // Digits, temp paths and durations are not a different crash.
  const again = `Error: the suite could not start after 12 ms\n    at file:///tmp/run-2/value.test.mjs:9:7`;
  const before = `Error: the suite could not start after 40 ms\n    at file:///private/tmp/run-9/value.test.mjs:9:7`;
  expect(crashSignature(run({ output: again }))).toBe(crashSignature(run({ output: before })));
  expect(crashSignature(run({ output: "Error: other\n    at f (x.mjs:1:1)" }))).not.toBe(
    crashSignature(run({})),
  );
  const python =
    'Traceback (most recent call last):\n  File "/t/a/suite.py", line 4, in <module>\nModuleNotFoundError: No module named x';
  expect(crashLine(python)).toBe("ModuleNotFoundError: No module named x");
  expect(crashSignature(run({ output: python }))).not.toBe(crashSignature(run({})));
});

it("does not hand off a timeout or environment failure that also names a failure", () => {
  const runs = (output: string, status: "timed-out" | "environment-failed") =>
    ["s1", "s2", "s3"].map((subjectDigest) => run({ status, output, subjectDigest }));
  for (const status of ["timed-out", "environment-failed"] as const) {
    expect(persistentPinnedFailure(runs("VISP: same", status), [NAME])).toMatchObject({ count: 3 });
    // A hanging product or a `listen EPERM` that a test reported is a failure of that test.
    expect(
      persistentPinnedFailure(runs(`FAIL: ${NAME}: listen EPERM`, status), [NAME]),
    ).toBeUndefined();
    expect(persistentPinnedFailure(runs("FAIL: other name: hang", status), [NAME])).toBeUndefined();
  }
});

it("does not count a crash that asks the product for a missing file", () => {
  const root = "/work/project";
  const missing = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/project/src/server.mjs' imported from /work/project/acceptance/f/a.mjs",
    "Error: spawn ./start.sh ENOENT",
    "FileNotFoundError: [Errno 2] No such file or directory: 'src/app.py'",
  ];
  for (const line of missing) expect(crashNamesProductPath(line, root), line).toBe(true);
  const other = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/project/acceptance/f/helper.mjs'",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/work/project/node_modules/x/index.js'",
    "Error: Cannot find module '/elsewhere/lib.js'",
    "Error: Cannot find module 'express'",
    "Error: spawn start.sh ENOENT",
    "Error: boom",
  ];
  for (const line of other) expect(crashNamesProductPath(line, root), line).toBe(false);
  const runs = ["s1", "s2", "s3"].map((subjectDigest) =>
    run({ subjectDigest, output: missing[0] as string }),
  );
  expect(persistentPinnedFailure(runs, [NAME])).toMatchObject({ count: 3 });
  expect(persistentPinnedFailure(runs, [NAME], root)).toBeUndefined();
  expect(persistentPinnedFailure(runs, [NAME], "/somewhere/else")).toMatchObject({ count: 3 });
});

it("does not count a Python import the product should provide", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-py-"));
  try {
    await mkdir(join(root, "src/pkg"), { recursive: true });
    await writeFile(join(root, "app.py"), "");
    await writeFile(join(root, "src/pkg/__init__.py"), "");
    await mkdir(join(root, "acceptance"), { recursive: true });
    // Not importable at all: the product should provide the module, present or not in the project.
    for (const line of [
      "ModuleNotFoundError: No module named 'app'",
      "ModuleNotFoundError: No module named 'app.server'",
      "ModuleNotFoundError: No module named 'lodash_like'",
    ])
      expect(crashNamesProductPath(line, root), line).toBe(true);
    // A name the project's own module lacks (app.py, app/, src/app.py or src/app/) is unfinished product.
    for (const module of ["app", "pkg", "pkg.sub"])
      expect(
        crashNamesProductPath(
          `ImportError: cannot import name 'run' from '${module}' (/x/y.py)`,
          root,
        ),
        module,
      ).toBe(true);
    // A standard or installed module missing a name is a fault of the suite, as before.
    for (const module of ["os", "collections.abc", "requests", "numpy"])
      expect(
        crashNamesProductPath(
          `ImportError: cannot import name 'nope' from '${module}' (/x/y.py)`,
          root,
        ),
        module,
      ).toBe(false);
    const runs = ["s1", "s2", "s3"].map((subjectDigest) =>
      run({ subjectDigest, output: "ModuleNotFoundError: No module named 'app'" }),
    );
    expect(persistentPinnedFailure(runs, [NAME])).toMatchObject({ count: 3 });
    expect(persistentPinnedFailure(runs, [NAME], root)).toBeUndefined();
    const stdlib = ["s1", "s2", "s3"].map((subjectDigest) =>
      run({ subjectDigest, output: "ImportError: cannot import name 'nope' from 'os' (/x/os.py)" }),
    );
    expect(persistentPinnedFailure(stdlib, [NAME], root)).toMatchObject({ count: 3 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads the frame of an unparenthesised Node stack line", () => {
  const at = (file: string) => run({ output: `${CRASH}\n    at file:///tmp/a/${file}:9:7` });
  expect(crashSignature(at("value.test.mjs"))).toBe(crashSignature(at("value.test.mjs")));
  expect(crashSignature(at("value.test.mjs"))).not.toBe(crashSignature(at("other.test.mjs")));
});

it("never calls a failure of a suite with no declared tests a crash", () => {
  // A project-pinned suite has no declared names: nothing tells its failed tests from a crash.
  expect(suiteCrashed(run({}), [])).toBe(false);
  const runs = [
    run({ subjectDigest: "s1" }),
    run({ subjectDigest: "s2" }),
    run({ subjectDigest: "s3" }),
  ];
  expect(persistentPinnedFailure(runs, [])).toBeUndefined();
  // An environment failure or a timeout needs no declared name to be told apart.
  expect(
    persistentPinnedFailure(
      runs.map((entry) => ({ ...entry, status: "timed-out" as const })),
      [],
    ),
  ).toMatchObject({ count: 3, status: "timed-out" });
});

it("never calls a failure of a suite with no declared tests a crash", () => {
  // A project-pinned suite has no declared names: nothing tells its failed tests from a crash.
  expect(suiteCrashed(run({}), [])).toBe(false);
  const runs = [
    run({ subjectDigest: "s1" }),
    run({ subjectDigest: "s2" }),
    run({ subjectDigest: "s3" }),
  ];
  expect(persistentPinnedFailure(runs, [])).toBeUndefined();
  // An environment failure or a timeout needs no declared name to be told apart.
  expect(
    persistentPinnedFailure(
      runs.map((entry) => ({ ...entry, status: "timed-out" as const })),
      [],
    ),
  ).toMatchObject({ count: 3, status: "timed-out" });
});

it("needs three identical runs across two source states before it calls a failure persistent", () => {
  const runs = [
    run({ subjectDigest: "s1" }),
    run({ subjectDigest: "s2" }),
    run({ subjectDigest: "s3" }),
  ];
  expect(persistentPinnedFailure(runs, [NAME])).toEqual({ count: 3, status: "crash", line: CRASH });
  // Two runs, or three runs on one source, are not enough.
  expect(persistentPinnedFailure(runs.slice(1), [NAME])).toBeUndefined();
  expect(persistentPinnedFailure([run({}), run({}), run({})], [NAME])).toBeUndefined();
  // A changed signature, a named failure or a pass resets the streak.
  const other = run({ output: "Error: something else\n    at f (x.mjs:2:2)", subjectDigest: "s2" });
  expect(
    persistentPinnedFailure([runs[0] as PinnedRun, other, runs[2] as PinnedRun], [NAME]),
  ).toBeUndefined();
  for (const breaker of [
    run({ output: `FAIL: ${NAME}: no`, subjectDigest: "s2" }),
    run({ status: "passed", subjectDigest: "s2" }),
  ])
    expect(
      persistentPinnedFailure(
        [runs[0] as PinnedRun, breaker, runs[2] as PinnedRun, run({ subjectDigest: "s4" })],
        [NAME],
      ),
    ).toBeUndefined();
  // An attributed failure at the end never qualifies, however many crashes came before.
  expect(
    persistentPinnedFailure([...runs, run({ output: `FAIL: ${NAME}: no` })], [NAME]),
  ).toBeUndefined();
  // Environment failures and timeouts count the same way.
  for (const status of ["environment-failed", "timed-out"] as const)
    expect(
      persistentPinnedFailure(
        runs.map((entry) => ({ ...entry, status, output: "VISP: same" })),
        [NAME],
      ),
    ).toMatchObject({ count: 3, status });
  expect(
    persistentPinnedFailure(
      [
        run({ status: "timed-out", output: "same" }),
        run({ status: "environment-failed", output: "same", subjectDigest: "s2" }),
        run({ status: "timed-out", output: "same", subjectDigest: "s3" }),
      ],
      [NAME],
    ),
  ).toBeUndefined();
});

// The suite fails by name until the product exists, then dies outside any test as soon as the
// product source carries a `// crash` marker; C001 (value is two) passes throughout.
// The tester gate wants three assertion words in a suite.
const SUITE = `// assert assert assert
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../src/value.mjs", import.meta.url), "utf8");
if (source.includes("// crash")) throw new Error("the suite could not start");
console.log("FAIL: ${NAME}: not implemented");
process.exitCode = 1;
`;
const ATTRIBUTED = `// assert assert assert
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../../src/value.mjs", import.meta.url), "utf8");
console.log("FAIL: ${NAME}: still wrong (" + source.length + ")");
process.exitCode = 1;
`;

const testerOf =
  (content: string): IndependentTester =>
  async () => ({
    file: { name: "value.test.mjs", content },
    tests: [{ name: NAME, quote: "Return two" }],
    notes: "",
  });

async function pinnedWorkspace(content: string) {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  const work = await runProductWork(
    await workspace.state(),
    { task: "T001" },
    inlineTests(testerOf(content)),
  );
  expect(work.ok && work.value.independentTests?.status, JSON.stringify(work)).toBe("pinned");
  return fixture;
}

async function doneAfterEdit(marker: number | undefined) {
  if (!workspace) throw new Error("no workspace");
  if (marker !== undefined)
    await workspace.write("src/value.mjs", `export const value = 2;\n// crash ${marker}\n`);
  const done = await runProductDoneReviewed(await workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  return done.ok ? done.value : undefined;
}

async function nextOf(feature: string) {
  if (!workspace) throw new Error("no workspace");
  const next = await runProductNext(await workspace.state(), { feature, task: "T001" });
  expect(next.ok, JSON.stringify(next)).toBe(true);
  if (!next.ok) throw new Error("next");
  return next.value;
}

it("explains a suite crash honestly and hands it off after three identical crashes across source changes", async () => {
  const fixture = await pinnedWorkspace(SUITE);
  const feature = fixture.brief.feature;
  const first = await doneAfterEdit(1);
  expect(first?.executions.find((entry) => entry.check.startsWith("PINNED_"))).toMatchObject({
    status: "failed",
    output: expect.stringContaining("the suite could not start"),
  });
  // The dispute hint is about a test that names itself; a crash has none.
  expect(first?.pinnedTests?.hint).toContain("crashed before it reported any declared test");
  expect(first?.pinnedTests?.hint).not.toContain("--dispute");
  const one = await nextOf(feature);
  expect(one.completion).not.toBe("handoff");
  expect(one.objective).toContain("crashed before it reported any declared test");
  expect(one.command).toContain("visp work");
  await doneAfterEdit(2);
  expect((await nextOf(feature)).completion).not.toBe("handoff");
  await doneAfterEdit(3);
  const handed = await nextOf(feature);
  expect(handed).toMatchObject({
    action: "fix",
    completion: "handoff",
    command: expect.stringContaining("visp pr"),
    mayEdit: false,
  });
  expect(handed.objective).toContain("crashed the same way in 3 runs while the product changed");
  expect(handed.objective).toContain("the suite could not start");
  // Handoff is disclosure: the slice is still open and the check still fails.
  const record = await readProductRecord(await state(), { feature });
  expect(record.ok && record.value.state.slices.T001?.status).not.toBe("closed");
  const again = await doneAfterEdit(4);
  expect(again?.closed).toBe(false);
  expect(again?.passed).toBe(false);
  // A pinned failure is also a correction check of the last slice: it still runs once per done.
  const runs = await readProductRecord(await state(), { feature });
  expect(
    runs.ok && runs.value.state.executions.filter((entry) => entry.check === "PINNED_1").length,
  ).toBe(4);
});

it("does not hand off three crashes on one source", async () => {
  const fixture = await pinnedWorkspace(SUITE);
  await doneAfterEdit(1);
  await doneAfterEdit(undefined);
  await doneAfterEdit(undefined);
  const next = await nextOf(fixture.brief.feature);
  expect(next.completion).not.toBe("handoff");
  expect(next.command).toContain("visp work");
});

it("never hands off a failure that names a test", async () => {
  const fixture = await pinnedWorkspace(ATTRIBUTED);
  for (const marker of [1, 2, 3, 4]) await doneAfterEdit(marker);
  const next = await nextOf(fixture.brief.feature);
  expect(next.completion).not.toBe("handoff");
  expect(next.objective).not.toContain("crashed");
  expect(next.evidence.join("\n")).toContain(`FAIL: ${NAME}`);
});

it("gives a pinned failure no slice claims to the slice that completes the feature", async () => {
  const fixture = await pinnedWorkspace(SUITE);
  const record = await readProductRecord(await state(), {
    feature: fixture.brief.feature,
  });
  if (!record.ok) throw new Error("record");
  const execution = {
    id: "e1",
    check: "PINNED_1",
    subjectDigest: "s",
    contractDigest: "c",
    createdAt: "2026-01-01T00:00:00.000Z",
    command: "node",
    status: "failed" as const,
    exitCode: 1,
    durationMs: 1,
    output: TRACE,
    provenance: "supervisor-executed" as const,
    assertions: "agent-reported" as const,
  };
  expect(failedCheckOwners(record.value, execution).map((slice) => slice.id)).toEqual(["T001"]);
  // Other unowned checks and passing pinned runs are unchanged.
  expect(failedCheckOwners(record.value, { ...execution, check: "C999" })).toEqual([]);
  expect(failedCheckOwners(record.value, { ...execution, status: "passed" })).toEqual([]);
});

/** Replaces the recorded runs with earlier pinned runs of one status, then the latest ones. */
async function withPinnedHistory(
  feature: string,
  status: "environment-failed" | "timed-out",
  extra: "none" | "non-pinned",
) {
  const record = await readProductRecord(await state(), { feature });
  if (!record.ok) throw new Error("record");
  const executions = record.value.state.executions;
  const latest = executions.findLast((entry) => entry.check.startsWith("PINNED_"));
  const project = executions.findLast((entry) => entry.check === "C001");
  if (!latest || !project) throw new Error("no runs");
  const same = { ...latest, status, exitCode: -1, output: "VISP: the same environment note" };
  const runs = [
    { ...same, id: "h1", subjectDigest: "old-one" },
    { ...same, id: "h2", subjectDigest: "old-two" },
    { ...same, id: "h3" },
  ];
  const failed = { ...project, id: "h4", status, output: "VISP: the same environment note" };
  const saved = await saveProductState(await state(), record.value, {
    ...record.value.state,
    executions: [project, ...runs, ...(extra === "non-pinned" ? [failed] : [])],
  });
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
}

for (const status of ["environment-failed", "timed-out"] as const) {
  it(`hands off a pinned suite that ended ${status} three times across two sources`, async () => {
    const fixture = await pinnedWorkspace(SUITE);
    const feature = fixture.brief.feature;
    await doneAfterEdit(1);
    await withPinnedHistory(feature, status, "none");
    expect(await nextOf(feature)).toMatchObject({
      completion: "handoff",
      command: expect.stringContaining("visp pr"),
      objective: expect.stringContaining("could not run the same way in 3 runs"),
      mayEdit: false,
    });
  });

  it(`keeps the environment step when a non-pinned check is also ${status}`, async () => {
    const fixture = await pinnedWorkspace(SUITE);
    const feature = fixture.brief.feature;
    await doneAfterEdit(1);
    await withPinnedHistory(feature, status, "non-pinned");
    const next = await nextOf(feature);
    expect(next.completion).not.toBe("handoff");
    expect(next.command).not.toContain("visp pr");
    expect(next.evidence.join("\n")).toContain("C001");
  });
}
