import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { ok } from "../../../../src/core/result.js";
import { withStateLock } from "../../../../src/core/state-lock.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import {
  runProductAcceptReviewed,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import {
  backgroundTests,
  codexTester,
  configuredTestsStarter,
  createProductFeatureWithTests,
  type IndependentTester,
  independentTestsBeforeWork,
  inlineTests,
  readTestsRecord,
  startIndependentTests,
  writeIndependentTests,
} from "../../../../src/workflow/product/independent-tests.js";
import { runProductReport } from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

// The fixture's module returns 1; the request promises 2.
const FAILS_FIRST = `import assert from "node:assert/strict";
import { value } from "../../src/value.mjs";
assert.equal(typeof value, "number");
assert.ok(Number.isInteger(value));
assert.equal(value, 2);
`;

async function testerWorkspace() {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  return fixture;
}

function tester(file: { name: string; content: string } | null, calls: string[] = []) {
  const run: IndependentTester = async (request) => {
    calls.push(request.prompt);
    return { file, tests: [{ name: "value", quote: "Return two" }], notes: "" };
  };
  return run;
}

it("reports a skipped tester when codex-exec uses a non-Codex critic", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "cursor", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  const state = await workspace.state();
  expect(configuredTestsStarter(state)).toBeUndefined();
  expect(await independentTestsBeforeWork(state, undefined, undefined, 0)).toMatchObject({
    ok: true,
    value: { status: "skipped", reason: expect.stringContaining("critic.harness: codex") },
  });
});

it("pins tests written from the original request when they fail before implementation", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const state = await fixture.workspace.state();
  const work = await runProductWork(
    state,
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST }, prompts)),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  const file = `acceptance/${fixture.brief.feature}/value.acceptance.mjs`;
  expect(work.value.independentTests).toMatchObject({
    status: "pinned",
    file,
    command: ["node", file],
  });
  // The tester sees the request, never the worker's plan or code.
  expect(prompts[0]).toContain("Return two from the public module");
  expect(prompts[0]).not.toContain("Return the promised value");
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([
    { command: ["node", file], files: [{ path: file, sha256: expect.any(String) }] },
  ]);
  expect(record.value.state.revisions.at(-1)).toMatchObject({ provenance: "visp-tester" });
  // Authorization follows the pin, so the slice contract already includes the tests.
  expect(record.value.state.slices.T001?.status).toBe("in-progress");
});

it("rejects tests that already pass, removes them and still authorizes the slice", async () => {
  const fixture = await testerWorkspace();
  const passing = `import assert from "node:assert/strict";\nassert.ok(true);\nassert.ok(1);\nassert.equal(1, 1);\n`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "vacuous.test.mjs", content: passing })),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  expect(work.value.independentTests).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("pass before any implementation"),
  });
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toEqual([]);
  await expect(
    readFile(join(fixture.workspace.root, `acceptance/${fixture.brief.feature}/vacuous.test.mjs`)),
  ).rejects.toThrow();
});

it("rejects a test file without enough assertions", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "thin.test.mjs", content: "process.exit(1);\n" })),
  );
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "rejected",
    reason: expect.stringContaining("assertions"),
  });
});

it("does not pin a suite when its interpreter exits with command-not-found", async () => {
  const fixture = await testerWorkspace();
  const content = `import assert from "node:assert/strict";
assert.ok(true); assert.ok(true); assert.ok(true);
process.exit(127);
`;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "missing-runtime.mjs", content }),
  );
  expect(result.ok && result.value.status).toBe("rejected");
  expect(result.ok && result.value.reason).toContain("could not start");
});

it("does not expose operator secrets to candidate tests", async () => {
  const fixture = await testerWorkspace();
  const previous = process.env.VISP_TEST_OPERATOR_SECRET;
  process.env.VISP_TEST_OPERATOR_SECRET = "secret";
  try {
    const content = `import assert from "node:assert/strict";
import { value } from "../../src/value.mjs";
assert.equal(process.env.VISP_TEST_OPERATOR_SECRET, undefined);
assert.equal(typeof value, "number");
assert.equal(value, 2);
`;
    const result = await writeIndependentTests(
      await fixture.workspace.state(),
      fixture.brief.feature,
      tester({ name: "secret-check.mjs", content }),
    );
    expect(result.ok && result.value.status).toBe("pinned");
    expect((await runProductWork(await fixture.workspace.state(), { task: "T001" })).ok).toBe(true);
    await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
    expect(done.ok && done.value.executions.find((run) => run.check === "PINNED_1")?.status).toBe(
      "passed",
    );
  } finally {
    if (previous === undefined) delete process.env.VISP_TEST_OPERATOR_SECRET;
    else process.env.VISP_TEST_OPERATOR_SECRET = previous;
  }
});

it("declines a baseline when the worker changes source during testing", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => {
      await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
      return {
        file: { name: "value.mjs", content: FAILS_FIRST },
        existingBehavior: false,
        tests: [{ name: "value", quote: "Return two" }],
        notes: "",
      };
    },
  );
  expect(result.ok && result.value.status).toBe("declined");
  expect(result.ok && result.value.reason).toContain("changed while the tester");
});

it("captures source before launching a detached tester", async () => {
  const fixture = await testerWorkspace();
  const state = await fixture.workspace.state();
  let calls = 0;
  await startIndependentTests(state, fixture.brief.feature, async (workspace, feature) => {
    await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
    return writeIndependentTests(workspace, feature, async () => {
      calls += 1;
      return { file: null, tests: [], notes: "" };
    });
  });
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record.ok && record.value?.status).toBe("declined");
  expect(record.ok && record.value?.reason).toContain("before the tester started");
  expect(calls).toBe(0);
});

it("declines a suite that admits it checks only file structure", async () => {
  const fixture = await testerWorkspace();
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    async () => ({
      file: {
        name: "structure.mjs",
        content:
          "import assert from 'node:assert/strict'; assert.ok(true); assert.ok(true); assert.ok(true); process.exit(1);",
      },
      existingBehavior: false,
      tests: [{ name: "file exists and parses", quote: "Create a game" }],
      notes: "I cannot test the behavior from this interface",
    }),
  );
  expect(result.ok && result.value.status).toBe("declined");
});

it("asks the tester once per feature, even when it fails", async () => {
  const fixture = await testerWorkspace();
  let calls = 0;
  const failing: IndependentTester = async () => {
    calls += 1;
    throw new Error("model unavailable");
  };
  const first = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(failing),
  );
  expect(first.ok && first.value.independentTests).toMatchObject({
    status: "failed",
    reason: "model unavailable",
  });
  const second = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(failing),
  );
  expect(second.ok, JSON.stringify(second)).toBe(true);
  expect(calls).toBe(1);
  const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
  expect(record.ok && record.value?.status).toBe("failed");
});

it("retries a failed tester only when explicitly requested", async () => {
  const fixture = await testerWorkspace();
  const state = await fixture.workspace.state();
  const failed = await writeIndependentTests(state, fixture.brief.feature, async () => {
    throw new Error("model unavailable");
  });
  expect(failed.ok && failed.value.status).toBe("failed");
  const retry = await writeIndependentTests(state, fixture.brief.feature, tester(null), true);
  expect(retry.ok && retry.value.status).toBe("declined");
});

it("does not spawn a background tester when Codex is missing", async () => {
  const fixture = await testerWorkspace();
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    expect(configuredTestsStarter(await fixture.workspace.state(), "mcp")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

it("waits through a long done lock instead of discarding candidate tests", async () => {
  const fixture = await testerWorkspace();
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const held = withStateLock(fixture.workspace.root, async () => {
    locked();
    await new Promise((resolve) => setTimeout(resolve, 5500));
    return ok(undefined);
  });
  await ready;
  const result = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: FAILS_FIRST }),
  );
  await held;
  expect(result.ok && result.value.status).toBe("pinned");
});

it("reports a live tester as running beyond ten minutes", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify({
      version: 1,
      status: "running",
      startedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      pid: process.pid,
    }),
  );
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester(null)),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("running");
});

it("does not launch a tester unless VISP launches the reviewer", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  let calls = 0;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async () => {
      calls += 1;
      return {};
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(calls).toBe(0);
});

it("runs the pinned tests when the last open slice is done", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  await fixture.workspace.write("src/value.mjs", "export const value = 3;\n");
  await fixture.workspace.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,3));\n",
  );
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  const pinned = done.value.executions.find((execution) => execution.check === "PINNED_1");
  expect(pinned?.status).toBe("failed");
  expect(done.value.closed).toBe(false);
  // The human reviewer sees what the tester relied on and who changed protected intent.
  const report = await runProductReport(await fixture.workspace.state());
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.markdown).toMatch(/## Checks[\s\S]*PINNED_1[\s\S]*failed/);
  expect(report.value.markdown).toMatch(/## Acceptance tests[\s\S]*\| value \| Return two \|/);
  expect(report.value.markdown).toMatch(/## Intent changes[\s\S]*visp-tester/);
});

// Hosts kill long shell commands and MCP calls time out; the tester outlives `work`.
it("lets the worker continue while a detached tester is still writing", async () => {
  const fixture = await testerWorkspace();
  const { writeFile } = await import("node:fs/promises");
  const cli = join(fixture.workspace.root, "..", `fake-visp-${Date.now()}.mjs`);
  await writeFile(
    cli,
    `import { mkdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const root = args[args.indexOf("--project") + 1];
const feature = args[args.indexOf("--feature") + 1];
const path = root + "/.visp/features/" + feature + "/acceptance-tests.json";
const startedAt = new Date().toISOString();
writeFileSync(path, JSON.stringify({ version: 1, status: "running", startedAt }));
setTimeout(() => writeFileSync(path, JSON.stringify({ version: 1, status: "declined", startedAt, reason: "No testable interface in the request" })), 1500);
`,
  );
  const first = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    backgroundTests(cli),
    300,
  );
  expect(first.ok && first.value.independentTests).toMatchObject({ status: "running" });
  for (let waited = 0; waited < 50; waited += 1) {
    const record = await readTestsRecord(await fixture.workspace.state(), fixture.brief.feature);
    if (record.ok && record.value?.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const second = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    backgroundTests(cli),
    10_000,
  );
  expect(second.ok && second.value.independentTests).toMatchObject({ status: "declined" });
});

// The tester needs only the request, so it writes while the worker drafts the brief.
it("starts the tester with the feature and keeps the worker's first brief an initial draft", async () => {
  const created = await TestWorkspace.create(
    { "src/value.mjs": "export const value = 1;\n" },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("install foundation");
  const starter = inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST }));
  // A worker's summary would become the only contract the tester and reviewer see.
  const summarized = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Return two" },
    starter,
  );
  expect(summarized.ok || summarized.error.recovery).toContain("--source-brief -");
  const feature = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Return two", sourceBrief: "Return two from the public module" },
    starter,
  );
  expect(feature.ok, JSON.stringify(feature)).toBe(true);
  if (!feature.ok) return;
  const id = feature.value.brief.feature;
  const tests = await readTestsRecord(await created.state(), id);
  expect(tests.ok && tests.value?.status).toBe("pinned");
  // No --reason: the pin by VISP's tester does not make this a revision.
  const drafted = await updateProductBrief(await created.state(), {
    feature: id,
    patch: {
      outcomes: [{ id: "O001", kind: "functional", statement: "The public value is two" }],
      checks: [
        {
          id: "C001",
          command: [process.execPath, `acceptance/${id}/value.acceptance.mjs`],
          outcomes: ["O001"],
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return two",
          outcomes: ["O001"],
          scope: { allowed: ["src/value.mjs"] },
          checks: ["C001"],
        },
      ],
    },
  });
  expect(drafted.ok, JSON.stringify(drafted)).toBe(true);
  const work = await runProductWork(await created.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
});

// Workers waited 1–2 minutes for the tester; tests now pin mid-slice without revoking work.
it("pins tests that arrive after a slice started and keeps the slice authorized", async () => {
  const fixture = await testerWorkspace();
  const work = await runProductWork(await fixture.workspace.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const late = await writeIndependentTests(
    await fixture.workspace.state(),
    fixture.brief.feature,
    tester({ name: "value.test.mjs", content: FAILS_FIRST }),
  );
  expect(late.ok && late.value.status).toBe("pinned");
  const record = await readProductRecord(await fixture.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.brief.acceptanceBaseline).toHaveLength(1);
  expect(record.value.state.slices.T001?.status).toBe("in-progress");
  await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
});

// Weak workers passed summaries and paraphrases as the request.
it("uses the host-recorded prompt unless the worker quotes it verbatim", async () => {
  const created = await TestWorkspace.create({ "src/value.mjs": "export const value = 1;\n" });
  workspace = created;
  await created.installFoundation();
  created.commit("install foundation");
  const prompts = ["Return two from the public module.\nKeep the module name.", "go ahead"].map(
    (prompt) => JSON.stringify({ at: "2026-09-24T00:00:00Z", prompt }),
  );
  await created.write(".visp/session/user-prompts.jsonl", `${prompts.join("\n")}\n`);
  const quoted = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Two", sourceBrief: "Return two from the public module. Keep the module name." },
    undefined,
  );
  expect(quoted.ok && quoted.value.brief.originalRequest).toBe(
    "Return two from the public module. Keep the module name.",
  );
  await expect(readFile(join(created.root, ".visp/session/user-prompts.jsonl"))).rejects.toThrow();
  await created.write(".visp/session/user-prompts.jsonl", `${prompts[0]}\n`);
  const truncated = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Four", sourceBrief: "Keep the module name." },
    undefined,
  );
  expect(truncated.ok && truncated.value.brief.originalRequest).toBe(
    "Return two from the public module.\nKeep the module name.",
  );
  await created.write(".visp/session/user-prompts.jsonl", `${prompts[0]}\n`);
  const paraphrased = await createProductFeatureWithTests(
    await created.state(),
    { goal: "Three", sourceBrief: "Make the module return 2" },
    undefined,
  );
  expect(paraphrased.ok && paraphrased.value.brief.originalRequest).toBe(
    "Return two from the public module.\nKeep the module name.",
  );
});

it("reports failing pinned tests at an earlier slice's done without blocking it", async () => {
  const fixture = await testerWorkspace();
  const brief = fixture.brief;
  const updated = await updateProductBrief(await fixture.workspace.state(), {
    reason: "Add a later slice",
    patch: {
      outcomes: [{ id: "O002", kind: "quality", statement: "The module is documented" }],
      slices: [
        {
          id: "T002",
          goal: "Document it",
          outcomes: ["O002"],
          dependsOn: ["T001"],
          scope: { allowed: ["README.md"] },
        },
      ],
    },
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  await fixture.workspace.write("src/value.mjs", "export const value = 3;\n");
  await fixture.workspace.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('v',()=>assert.equal(value,3));\n",
  );
  const done = await runProductDoneReviewed(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(true);
  expect(done.value.acceptanceTests).toEqual([
    expect.objectContaining({ passing: false, failure: expect.stringContaining("3 !== 2") }),
  ]);
  expect(brief.feature).toBeTruthy();
});

// Weak workers were sent to the host review protocol at acceptance and stopped there.
it("has VISP's reviewer assess the assembled product when acceptance lacks an assessment", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const work = await runProductWork(await fixture.workspace.state(), { task: "T001" });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  await fixture.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDone(await fixture.workspace.state(), { task: "T001" });
  expect(done.ok && done.value.closed, JSON.stringify(done)).toBe(true);
  const selections: unknown[] = [];
  const accepted = await runProductAcceptReviewed(
    await fixture.workspace.state(),
    {},
    async (_workspace, selection) => {
      selections.push(selection);
      return { reviewed: false, findings: [], reason: "reviewer unavailable in test" };
    },
  );
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.value.passed).toBe(false);
  expect(selections).toEqual([{ feature: fixture.brief.feature }]);
  expect(accepted.value.critic).toMatchObject({ reason: "reviewer unavailable in test" });
});

const BAD_THEN_GOOD = (value: string) => `import assert from "node:assert/strict";
import { value } from "../../src/value.mjs";
assert.equal(typeof value, "number");
assert.ok(Number.isInteger(value));
assert.equal(value, ${value});
`;

// On an existing codebase, trial suites were wrong in every variant tried.
it("does not launch the tester on an existing codebase", async () => {
  const fixture = await testerWorkspace();
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  fixture.workspace.commit("existing code");
  let calls = 0;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async () => {
      calls += 1;
      return {};
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(calls).toBe(0);
});

it("gives the tester one repair round with the failure output", async () => {
  const fixture = await testerWorkspace();
  const prompts: string[] = [];
  const repairing: IndependentTester = async (request) => {
    prompts.push(request.prompt);
    return {
      // The first file passes before implementation, so it checks nothing new.
      file: { name: "value.test.mjs", content: BAD_THEN_GOOD(prompts.length === 1 ? "1" : "2") },
      tests: [{ name: "value", quote: "Return two" }],
      notes: "",
    };
  };
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(repairing),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("pass before any implementation");
});

// Codex's sandbox ends background processes when a command finishes; the record said
// "running" forever.
it("reports a tester whose process has ended as failed", async () => {
  const fixture = await testerWorkspace();
  await fixture.workspace.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify({
      version: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      pid: 2 ** 22 + 7,
    }),
  );
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: FAILS_FIRST })),
  );
  expect(work.ok && work.value.independentTests).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("host may end background processes"),
  });
});

it("runs the tester on an existing codebase in a writable copy only when opted in", async () => {
  const fixture = await testerWorkspace();
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, existingCodeTests: true };
  await fixture.workspace.write("visp.yml", stringify(config));
  fixture.workspace.commit("existing code, opted in");
  const requests: { explore?: boolean; prompt: string }[] = [];
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(async (request) => {
      requests.push(request);
      return { file: null, existingBehavior: true, tests: [], notes: "" };
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(requests[0]?.explore).toBe(true);
  expect(requests[0]?.prompt).toContain("run the program and observe it");
});

// Execution mode gives a model network access: no secrets in its copy, every command logged.
it("keeps secret and blocked files out of the tester's copy and lists its commands", async () => {
  const fixture = await testerWorkspace();
  const { chmod, writeFile } = await import("node:fs/promises");
  for (const name of ["a", "b", "c"])
    await fixture.workspace.write(`lib/${name}.mjs`, "export const x = 1;\n");
  const config = parse(await readFile(join(fixture.workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, existingCodeTests: true };
  config.workflow = { ...config.workflow, blockedPaths: ["private/**"] };
  await fixture.workspace.write("visp.yml", stringify(config));
  fixture.workspace.commit("existing code, opted in");
  // Untracked but not ignored: git ls-files -co lists them.
  await fixture.workspace.write(".env", "TOKEN=secret\n");
  await fixture.workspace.write("config/server.pem", "key\n");
  await fixture.workspace.write("private/notes.txt", "internal\n");
  const fake = join(fixture.workspace.root, "..", `fake-codex-${Date.now()}.mjs`);
  await writeFile(
    fake,
    `#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
const args = process.argv.slice(2);
const root = args[args.indexOf("--cd") + 1];
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [relative(root, join(dir, entry.name))]);
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "curl -s http://localhost:8080/items" } }));
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
  file: null, existingBehavior: false, tests: [],
  notes: JSON.stringify({ files: walk(root), env: args.includes('shell_environment_policy.inherit="core"') }),
}));
`,
  );
  await chmod(fake, 0o755);
  const state = await fixture.workspace.state();
  const record = await writeIndependentTests(
    state,
    fixture.brief.feature,
    codexTester({ executable: fake, lookup: async () => undefined }),
  );
  if (!record.ok) throw new Error(record.error.message);
  const seen = JSON.parse(record.value.notes ?? "{}") as { files: string[]; env: boolean };
  expect(seen.files).toContain("lib/a.mjs");
  expect(seen.files).not.toContain(".env");
  expect(seen.files).not.toContain("config/server.pem");
  expect(seen.files).not.toContain("private/notes.txt");
  expect(seen.env).toBe(true);
  const report = await runProductReport(await fixture.workspace.state());
  if (!report.ok) throw new Error(report.error.message);
  expect(report.value.markdown).toMatch(
    /## Tester commands with network access[\s\S]*curl -s http:\/\/localhost:8080\/items/,
  );
});

it("runs a new-project tester in an empty directory and sweeps abandoned auth copies", async () => {
  const fixture = await testerWorkspace();
  const { chmod, mkdir, mkdtemp, utimes, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const stale = await mkdtemp(join(tmpdir(), "visp-tester-"));
  await mkdir(join(stale, "codex-home"));
  await writeFile(join(stale, "codex-home", "auth.json"), "secret");
  const old = new Date(Date.now() - 25 * 60 * 60_000);
  await utimes(stale, old, old);
  const fake = join(fixture.workspace.root, "..", `fake-codex-empty-${Date.now()}.mjs`);
  await writeFile(
    fake,
    `#!${process.execPath}
import { readdirSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const root = args[args.indexOf("--cd") + 1];
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({
  file: null, existingBehavior: false, tests: [], notes: JSON.stringify(readdirSync(root)),
}));
`,
  );
  await chmod(fake, 0o755);
  const response = (await codexTester({ executable: fake, lookup: async () => undefined })({
    root: fixture.workspace.root,
    model: "fake",
    prompt: "Test behavior",
    schema: {},
  })) as { notes: string };
  expect(JSON.parse(response.notes)).toEqual([]);
  await expect(readFile(join(stale, "codex-home", "auth.json"))).rejects.toThrow();
});

// A suite that starts a server left it running after the baseline run.
it("ends every process a baseline test run started", async () => {
  const fixture = await testerWorkspace();
  const pidFile = join(fixture.workspace.root, "..", `leak-${Date.now()}.pid`);
  const leaking = `import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { value } from "../../src/value.mjs";
const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
assert.equal(typeof value, "number");
assert.ok(Number.isInteger(value));
assert.equal(value, 2);
`;
  const work = await runProductWork(
    await fixture.workspace.state(),
    { task: "T001" },
    inlineTests(tester({ name: "value.test.mjs", content: leaking })),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  const pid = Number(await readFile(pidFile, "utf8"));
  const alive = (() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  expect(alive).toBe(false);
});
