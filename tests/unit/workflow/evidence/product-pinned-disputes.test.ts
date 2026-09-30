import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { balancedCritic } from "../../../../src/config/critic.js";
import { type CriticPacket, runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductAcceptReviewed,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { independentReviewJsonSchema } from "../../../../src/workflow/product/independent-review.js";
import {
  type IndependentTester,
  inlineTests,
  readTestsRecord,
} from "../../../../src/workflow/product/independent-tests.js";
import {
  runProductNext,
  runProductReport,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import {
  allFailuresIn,
  environmentErrorLine,
  environmentOnly,
  failingTests,
  failLineStats,
  waivedFailure,
} from "../../../../src/workflow/product/pinned-dispute-model.js";
import {
  disputeInput,
  fileDisputes,
  sourceExcerpt,
} from "../../../../src/workflow/product/pinned-disputes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { compactProductReply } from "../../../../src/workflow/product-compact-text.js";
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

const ODD = "value is odd";
const TWO = "value is two";
const REASON =
  'The request says "Return two"; two is even, so a test that wants an odd value is wrong';
// The fixture module returns 1 at first; the request promises 2. The odd test is itself wrong.
function buildSuite(checks: readonly (readonly [string, string])[], skips = true) {
  return `import assert from "node:assert/strict";
import { value } from "../../src/value.mjs";
const waived = new Set(${skips ? 'JSON.parse(process.env.VISP_WAIVED_TESTS ?? "[]")' : "[]"});
let failed = false;
function check(name, run) {
  if (waived.has(name)) return;
  try { run(); console.log(\`PASS: \${name}\`); } catch (error) { failed = true; console.log(\`FAIL: \${name}: \${error.message}\`); }
}
${checks.map(([name, expression]) => `check(${JSON.stringify(name)}, () => assert.ok(${expression}));`).join("\n")}
process.exitCode = failed ? 1 : 0;
`;
}
const CHECKS = [
  ["value is a number", 'typeof value === "number"'],
  [TWO, "value === 2"],
  [ODD, "value % 2 === 1"],
] as const;
const NATIVE = balancedCritic("codex") ?? { model: "missing" };
const CONFIG = { model: "test-critic", maxCalls: 4, timeoutMs: 5000, maxImageBytes: 4194304 };

const testerOf =
  (checks: readonly (readonly [string, string])[], skips = true): IndependentTester =>
  async () => ({
    file: { name: "value.test.mjs", content: buildSuite(checks, skips) },
    tests: checks.map(([name]) => ({ name, quote: "Return two" })),
    notes: "",
  });

/** A pinned suite with one wrong test, an implemented product, and a configured reviewer. */
async function disputeWorkspace(
  options: {
    reviewer?: boolean;
    checks?: readonly (readonly [string, string])[];
    skips?: boolean;
    value?: number;
    maxCalls?: number;
    native?: boolean;
  } = {},
) {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = {
    ...config.critic,
    harness: "codex",
    launch: options.reviewer === false ? undefined : "codex-exec",
    mode: "auto",
  };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  const work = await runProductWork(
    await workspace.state(),
    { task: "T001" },
    inlineTests(testerOf(options.checks ?? CHECKS, options.skips ?? true)),
  );
  expect(work.ok && work.value.independentTests?.status, JSON.stringify(work)).toBe("pinned");
  const configured = await runProductCritic(await workspace.state(), {
    task: "T001",
    operation: "configure",
    config: options.native
      ? { ...NATIVE, maxCalls: 3 }
      : { ...CONFIG, maxCalls: options.maxCalls ?? CONFIG.maxCalls },
  });
  expect(configured.ok, JSON.stringify(configured)).toBe(true);
  await workspace.write("src/value.mjs", `export const value = ${options.value ?? 2};\n`);
  return fixture;
}

type Ruling = { test: string; ruling: "upheld" | "rejected"; reasoning: string };

/** An independent-format review response that rules on whatever disputes the packet holds. */
function reviewer(rule: (packet: CriticPacket) => Ruling[]) {
  const packets: CriticPacket[] = [];
  const host = {
    review: vi.fn(async (packet: CriticPacket) => {
      packets.push(packet);
      return {
        model: CONFIG.model,
        response: {
          summary: "Executed the module and observed the promised value",
          assessments: packet.current.outcomes.map((outcome) => ({
            outcome: outcome.id,
            status: "satisfied",
            summary: "The public value is two",
            evidence: ["C001"],
            expectations: [],
          })),
          findings: [],
          limitations: [],
          resolutions: [],
          disputes: rule(packet),
        },
      };
    }),
  };
  return { host, packets };
}

const upholdAll = (packet: CriticPacket): Ruling[] =>
  (packet.disputes ?? []).map((entry) => ({
    test: entry.test,
    ruling: "upheld",
    reasoning: 'The request says "Return two"; an odd value contradicts it',
  }));
const rejectAll = (packet: CriticPacket): Ruling[] =>
  (packet.disputes ?? []).map((entry) => ({
    test: entry.test,
    ruling: "rejected",
    reasoning:
      "The request does not say the value is even or odd; the product must satisfy the test",
  }));

async function disputes(state: Awaited<ReturnType<TestWorkspace["state"]>>, feature: string) {
  const record = await readTestsRecord(state, feature);
  return record.ok ? (record.value?.disputes ?? []) : [];
}

it("still fails the pinned suite and keeps the reviewer away without a dispute", async () => {
  const fixture = await disputeWorkspace();
  const starter = vi.fn(async () => ({ reviewed: true, findings: [] }));
  const done = await runProductDoneReviewed(await state(), { task: "T001" }, starter);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(false);
  expect(starter).not.toHaveBeenCalled();
  // The reply states the dispute command next to the failing test.
  expect(done.value.pinnedTests?.hint).toContain('--dispute "<test name>"');
  // VISP starts the reviewer during that command; the worker delegates nothing.
  expect(done.value.pinnedTests?.hint).toContain(
    "VISP itself launches the reviewer during that command",
  );
  expect(done.value.pinnedTests?.hint).toContain("you delegate nothing");
  expect(done.value.pinnedTests?.hint).toContain("visp done --dispute");
  expect(done.value.pinnedTests?.hint).not.toContain("The independent reviewer rules");
  const next = await runProductNext(await state(), {
    feature: fixture.brief.feature,
    task: "T001",
  });
  expect(next.ok && next.value.evidence[0]).toContain("--dispute");
});

it("launches the reviewer when the only failure is a disputed pinned test", async () => {
  const fixture = await disputeWorkspace();
  const { host, packets } = reviewer(upholdAll);
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(host.review).toHaveBeenCalledTimes(1);
  // The reviewer gets the test, its failure output, the source excerpt and the reason.
  const [dispute] = packets[0]?.disputes ?? [];
  expect(dispute).toMatchObject({
    test: ODD,
    workerReason: REASON,
    requestQuote: "Return two",
    failureOutput: expect.stringContaining(`FAIL: ${ODD}`),
    testSource: expect.stringContaining("value % 2"),
  });
  expect(packets[0]?.instructions).toContain("disputes lists pinned acceptance tests");
  const schema = independentReviewJsonSchema([], [], [ODD]) as {
    properties: { disputes: { items: { properties: { test: { enum: string[] } } } } };
  };
  expect(schema.properties.disputes.items.properties.test.enum).toEqual([ODD]);
  const packetSchema = packets[0]?.responseSchema as {
    properties: { disputes: { maxItems: number } };
  };
  expect(packetSchema.properties.disputes.maxItems).toBe(1);
  expect(await disputes(await state(), fixture.brief.feature)).toEqual([
    expect.objectContaining({ test: ODD, status: "upheld", reason: REASON }),
  ]);
  const ruled = await disputes(await state(), fixture.brief.feature);
  expect(ruled[0]?.ruling?.reasoning).toContain("Return two");
  expect(done.value.pinnedTests?.disputes).toEqual([
    expect.objectContaining({ test: ODD, status: "upheld" }),
  ]);
  expect(compactProductReply("done", done.value, "cli")).toContain("pinnedTests");
  // The human reviewer sees the waiver with both sides' reasoning.
  const report = await runProductReport(await state(), {});
  expect(report.ok && report.value.markdown).toContain(`${ODD}: upheld, waived. Reason:`);
});

it("waives an upheld test: the suite skips it and the slice closes and accepts", async () => {
  await disputeWorkspace();
  const { host } = reviewer(upholdAll);
  const first = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(first.ok && first.value.closed).toBe(true);
  const again = await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(host));
  expect(again.ok, JSON.stringify(again)).toBe(true);
  if (!again.ok) return;
  expect(again.value.closed, JSON.stringify(again.value.gaps)).toBe(true);
  // The reviewer already ruled on this exact source; the same review is not spent twice.
  expect(host.review).toHaveBeenCalledTimes(1);
  const accepted = await runProductAcceptReviewed(await state(), {}, inlineReview(host));
  expect(accepted.ok && accepted.value.passed, JSON.stringify(accepted)).toBe(true);
});

it("keeps a rejected test required and refuses to re-file it on the same source", async () => {
  const fixture = await disputeWorkspace();
  const { host } = reviewer(rejectAll);
  const first = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(first.value.closed).toBe(false);
  expect(first.value.pinnedTests?.disputes?.[0]).toMatchObject({
    status: "rejected",
    note: expect.stringContaining("must satisfy this test"),
  });
  const feature = fixture.brief.feature;
  expect(await disputes(await state(), feature)).toEqual([
    expect.objectContaining({ status: "rejected" }),
  ]);
  const refiled = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(refiled.ok && refiled.value.pinnedTests?.filed).toEqual([
    expect.objectContaining({
      status: "refused",
      detail: expect.stringContaining("rejected this dispute on this exact source"),
    }),
  ]);
  expect(host.review).toHaveBeenCalledTimes(1);
  // A product change lets the test be disputed again; the suite still requires it meanwhile.
  await workspace?.write("src/value.mjs", "// changed\nexport const value = 2;\n");
  const changed = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(reviewer(upholdAll).host),
  );
  expect(changed.ok && changed.value.pinnedTests?.filed?.[0]?.status).toBe("filed");
});

it("refuses disputes of tests that did not fail, are unknown, or lack a reason", async () => {
  const fixture = await disputeWorkspace();
  const starter = vi.fn(async () => ({ reviewed: true, findings: [] }));
  const current = await state();
  const passing = await runProductDoneReviewed(
    current,
    { task: "T001", dispute: [TWO, "no such test"], disputeReason: REASON },
    starter,
  );
  expect(passing.ok, JSON.stringify(passing)).toBe(true);
  if (!passing.ok) return;
  expect(passing.value.pinnedTests?.filed).toEqual([
    expect.objectContaining({
      test: TWO,
      status: "refused",
      detail: expect.stringContaining("only failing tests"),
    }),
    expect.objectContaining({
      test: "no such test",
      status: "refused",
      detail: expect.stringContaining("matches no declared test"),
    }),
  ]);
  // Nothing was filed, so the reviewer stays out of it.
  expect(starter).not.toHaveBeenCalled();
  expect(await disputes(await state(), fixture.brief.feature)).toEqual([]);
  // A run in which the pinned suite passes has nothing to dispute.
  const record = await readTestsRecord(current, fixture.brief.feature);
  const outcome = await fileDisputes(
    current,
    fixture.brief.feature,
    { tests: [ODD], reason: REASON },
    [],
    "digest",
  );
  expect(record.ok).toBe(true);
  expect(outcome.ok && outcome.value[0]).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("did not fail as a blocking check"),
  });
});

it("requires a reason, before any check runs", async () => {
  await disputeWorkspace();
  const starter = vi.fn(async () => ({ reviewed: true, findings: [] }));
  for (const disputeReason of [undefined, "", "   ", "too short"]) {
    const done = await runProductDoneReviewed(
      await state(),
      { task: "T001", dispute: [ODD], ...(disputeReason === undefined ? {} : { disputeReason }) },
      starter,
    );
    expect(done).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("reason") },
    });
  }
  expect(disputeInput({ disputeReason: REASON })).toMatchObject({ ok: false });
  expect(disputeInput({})).toEqual({ ok: true, value: undefined });
  const record = await readProductRecord(await state(), { task: "T001" });
  expect(record.ok && record.value.state.executions).toEqual([]);
  expect(starter).not.toHaveBeenCalled();
});

it("never lets the worker rule: rulings come only from a returned review", async () => {
  const fixture = await disputeWorkspace();
  // The reviewer answers without ruling on the dispute; it stays open and required.
  const { host } = reviewer(() => []);
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(false);
  expect(await disputes(await state(), fixture.brief.feature)).toEqual([
    expect.objectContaining({ status: "open" }),
  ]);
  expect(done.value.pinnedTests?.disputes?.[0]?.note).toContain(
    "awaiting the independent reviewer",
  );
});

it("says a pinned test cannot be waived when no reviewer runs", async () => {
  const fixture = await disputeWorkspace({ reviewer: false });
  const done = await runProductDoneReviewed(await state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.pinnedTests?.hint).toContain("cannot be waived");
  // With nobody to rule, a dispute is refused outright rather than left open forever.
  const disputed = await runProductDoneReviewed(await state(), {
    task: "T001",
    dispute: [ODD],
    disputeReason: REASON,
  });
  expect(disputed).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("No independent reviewer runs") },
  });
  const next = await runProductNext(await state(), {
    feature: fixture.brief.feature,
    task: "T001",
  });
  expect(next.ok && next.value.evidence[0]).toContain("cannot be waived");
});

it("excerpts the test source around its name", () => {
  const source = `${"x\n".repeat(400)}check("target test", () => {});\n${"y\n".repeat(400)}`;
  const excerpt = sourceExcerpt(source, "target test");
  expect(excerpt).toContain('check("target test"');
  expect(excerpt.length).toBeLessThan(source.length);
  expect(sourceExcerpt("short file", "absent")).toBe("short file");
});

it("teaches the tester to contain teardown errors, avoid incidental order and honor waivers", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  const prompts: string[] = [];
  const work = await runProductWork(
    await workspace.state(),
    { task: "T001" },
    inlineTests(async (request) => {
      prompts.push(request.prompt);
      return { file: null, tests: [], notes: "" };
    }),
  );
  expect(work.ok, JSON.stringify(work)).toBe(true);
  const [prompt] = prompts;
  expect(prompt).toContain("Only the checks' own assertions may fail the run");
  expect(prompt).toContain("cleaning up after the tests");
  expect(prompt).toContain("removing temporary directories");
  expect(prompt).toContain("must never change the exit status");
  expect(prompt).toContain("incidental ordering");
  expect(prompt).toContain("object key order");
  expect(prompt).toContain("Set or dict iteration order");
  expect(prompt).toContain("VISP_WAIVED_TESTS");
  expect(prompt).toContain("FAIL: <exact name from tests[].name>");
});

const WRONG = ["value is odd", "value is above ten"] as const;
const TWO_WRONG = [...CHECKS, [WRONG[1], "value > 10"]] as const;

async function recordPath(feature: string) {
  return join(workspace?.root ?? "", ".visp/features", feature, "acceptance-tests.json");
}

it("states the dispute command once per reply, and only for a blocking run", async () => {
  await disputeWorkspace();
  const done = await runProductDoneReviewed(await state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  const text = compactProductReply("done", done.value, "cli") ?? "";
  expect(text.split("--dispute").length - 1).toBe(1);
});

it("gives no dispute hint on an early slice and refuses a dispute there", async () => {
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  const updated = await updateProductBrief(await workspace.state(), {
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
    await workspace.state(),
    { task: "T001" },
    inlineTests(testerOf(CHECKS)),
  );
  expect(work.ok && work.value.independentTests?.status).toBe("pinned");
  expect(work.ok && JSON.stringify(work.value.independentTests)).not.toContain("--dispute");
  await workspace.write("src/value.mjs", "export const value = 3;\n");
  await workspace.write(
    "test/value.test.mjs",
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('v',()=>assert.equal(value,3));\n",
  );
  const done = await runProductDoneReviewed(
    await workspace.state(),
    { task: "T001", dispute: [TWO], disputeReason: REASON },
    vi.fn(async () => ({ reviewed: true, findings: [] })),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(true);
  expect(done.value.acceptanceTests?.[0]?.passing).toBe(false);
  expect(JSON.stringify(done.value.acceptanceTests)).not.toContain("--dispute");
  expect(done.value.pinnedTests?.hint).toBeUndefined();
  expect(done.value.pinnedTests?.filed).toEqual([
    expect.objectContaining({
      status: "refused",
      detail: expect.stringContaining("only runs for information"),
    }),
  ]);
});

it("keeps the run blocked while another failing test has no dispute", async () => {
  const fixture = await disputeWorkspace({ checks: TWO_WRONG });
  const { host } = reviewer(upholdAll);
  const partial = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(partial.ok, JSON.stringify(partial)).toBe(true);
  if (!partial.ok) return;
  // The dispute is filed, but the run also fails "value is above ten": no review yet.
  expect(partial.value.pinnedTests?.filed?.[0]?.status).toBe("filed");
  expect(host.review).not.toHaveBeenCalled();
  const full = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [WRONG[1]], disputeReason: REASON },
    inlineReview(host),
  );
  expect(full.ok, JSON.stringify(full)).toBe(true);
  expect(host.review).toHaveBeenCalledTimes(1);
  const ruled = await disputes(await state(), fixture.brief.feature);
  expect(ruled.map((entry) => entry.status)).toEqual(["upheld", "upheld"]);
});

it("does not treat a name in a PASS line as a failing test", async () => {
  await disputeWorkspace();
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [TWO], disputeReason: REASON },
    vi.fn(async () => ({ reviewed: true, findings: [] })),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  const execution = done.value.executions.find((entry) => entry.check === "PINNED_1");
  expect(execution?.output).toContain(`PASS: ${TWO}`);
  expect(done.value.pinnedTests?.filed?.[0]).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("FAIL"),
  });
});

it("allows at most five disputes to await a ruling", async () => {
  const many = Array.from({ length: 7 }, (_, index) => [`case ${index}`, "value === 100"] as const);
  const fixture = await disputeWorkspace({ checks: many });
  const failing = [
    {
      check: "PINNED_1",
      output: many.map(([name]) => `FAIL: ${name}: expected 100`).join("\n"),
    },
  ];
  const outcome = await fileDisputes(
    await state(),
    fixture.brief.feature,
    { tests: many.map(([name]) => name), reason: REASON },
    failing,
    "digest",
  );
  expect(outcome.ok && outcome.value.map((entry) => entry.status)).toEqual([
    "filed",
    "filed",
    "filed",
    "filed",
    "filed",
    "refused",
    "refused",
  ]);
  expect(await disputes(await state(), fixture.brief.feature)).toHaveLength(5);
  // Another call cannot exceed five open disputes either.
  const again = await fileDisputes(
    await state(),
    fixture.brief.feature,
    { tests: ["case 6"], reason: REASON },
    failing,
    "digest",
  );
  expect(again.ok && again.value[0]).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("At most 5"),
  });
});

it("ignores rulings from a native, host-submitted review", async () => {
  const fixture = await disputeWorkspace({ native: true });
  const capabilities = {
    harness: "codex",
    model: NATIVE.model,
    reasoningEffort: "high",
    freshContext: true,
    images: true,
    readOnly: true,
    delegationAllowed: true,
  };
  // A new workspace state under the native preset; the dispute is filed by `done`.
  const filed = await runProductDoneReviewed(await state(), {
    task: "T001",
    dispute: [ODD],
    disputeReason: REASON,
  });
  expect(filed.ok && filed.value.pinnedTests?.filed?.[0]?.status, JSON.stringify(filed)).toBe(
    "filed",
  );
  const run = async (input: object) => runProductCritic(await state(), { task: "T001", ...input });
  const reconfigured = await run({ operation: "prepare", capabilities });
  expect(reconfigured.ok, JSON.stringify(reconfigured)).toBe(true);
  if (!reconfigured.ok) return;
  const prepared = reconfigured.value as { attempt: string; packetPath: string };
  const packet = JSON.parse(await readFile(prepared.packetPath, "utf8")) as CriticPacket;
  expect(packet.disputes?.map((entry) => entry.test)).toEqual([ODD]);
  const submitted = await run({
    operation: "submit",
    result: {
      attempt: prepared.attempt,
      model: NATIVE.model,
      reasoningEffort: "high",
      context: "fresh",
      response: {
        summary: "Looks fine",
        assessments: [],
        findings: [],
        limitations: [],
        resolutions: [],
        disputes: upholdAll(packet),
      },
    },
  });
  expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
  // Whatever the submission was worth, it waived nothing.
  const after = await disputes(await state(), fixture.brief.feature);
  expect(after).toEqual([expect.objectContaining({ status: "open", reviews: 1 })]);
  const done = await runProductDoneReviewed(await state(), { task: "T001" });
  expect(done.ok && done.value.closed).toBe(false);
});

it("ignores a hand-edited upheld status in acceptance-tests.json", async () => {
  const fixture = await disputeWorkspace();
  const filed = await runProductDoneReviewed(await state(), {
    task: "T001",
    dispute: [ODD],
    disputeReason: REASON,
  });
  expect(filed.ok && filed.value.pinnedTests?.filed?.[0]?.status).toBe("filed");
  const path = await recordPath(fixture.brief.feature);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.disputes[0] = {
    ...record.disputes[0],
    status: "upheld",
    ruling: {
      ruling: "upheld",
      reasoning: "edited by hand",
      at: new Date().toISOString(),
      subject: record.disputes[0].subject,
      attempt: "00000000-0000-4000-8000-000000000000",
      evidence: "made-up",
    },
  };
  await workspace?.write(
    `.visp/features/${fixture.brief.feature}/acceptance-tests.json`,
    JSON.stringify(record, null, 2),
  );
  const done = await runProductDoneReviewed(await state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.closed).toBe(false);
  const execution = done.value.executions.find((entry) => entry.check === "PINNED_1");
  expect(execution?.status).toBe("failed");
  expect(done.value.pinnedTests?.disputes?.[0]?.note).toContain("does not match the review record");
});

it("counts an upheld test as waived when the suite cannot skip it, so accept is not a dead end", async () => {
  await disputeWorkspace({ skips: false });
  const { host } = reviewer(upholdAll);
  const first = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(first.ok && first.value.closed).toBe(true);
  const again = await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(host));
  expect(again.ok, JSON.stringify(again)).toBe(true);
  if (!again.ok) return;
  const execution = first.ok
    ? first.value.executions.find((entry) => entry.check === "PINNED_1")
    : undefined;
  expect(execution?.status).toBe("passed");
  expect(execution?.output).toContain("waived by the independent review");
  expect(again.value.closed, JSON.stringify(again.value.gaps)).toBe(true);
  const accepted = await runProductAcceptReviewed(await state(), {}, inlineReview(host));
  expect(accepted.ok && accepted.value.passed, JSON.stringify(accepted)).toBe(true);
});

it("does not waive a suite failure that is not entirely a waived test", async () => {
  const fixture = await disputeWorkspace({ skips: false, checks: TWO_WRONG });
  const { host } = reviewer((packet) =>
    (packet.disputes ?? []).map((entry) => ({
      test: entry.test,
      ruling: "upheld" as const,
      reasoning: 'The request says "Return two"; an odd value contradicts it',
    })),
  );
  await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: WRONG.slice(), disputeReason: REASON },
    inlineReview(host),
  );
  // A third, undisputed failure keeps the check failing even though two tests are waived.
  await workspace?.write("src/value.mjs", "export const value = 1;\n");
  const again = await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(host));
  expect(
    again.ok && again.value.executions.find((entry) => entry.check === "PINNED_1")?.status,
  ).toBe("failed");
  expect(fixture.brief.feature).toBeTruthy();
});

it("allows one more review of a dispute the reviewer left unruled, then hands it off", async () => {
  const fixture = await disputeWorkspace();
  const { host } = reviewer(() => []);
  const first = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(first.ok, JSON.stringify(first)).toBe(true);
  expect(host.review).toHaveBeenCalledTimes(1);
  // Same source, same evidence: the duplicate-review rule must not lock the dispute forever.
  const second = await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(host));
  expect(second.ok, JSON.stringify(second)).toBe(true);
  expect(host.review).toHaveBeenCalledTimes(2);
  const feature = fixture.brief.feature;
  expect((await disputes(await state(), feature))[0]).toMatchObject({ status: "open", reviews: 2 });
  // Exactly one more: a third `done` spends no review and hands the dispute to `visp pr`.
  const third = await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(host));
  expect(third.ok, JSON.stringify(third)).toBe(true);
  if (!third.ok) return;
  expect(host.review).toHaveBeenCalledTimes(2);
  expect(third.value.pinnedTests?.disputes?.[0]?.note).toContain("visp pr");
  const next = await runProductNext(await state(), { feature, task: "T001" });
  expect(next.ok && next.value).toMatchObject({
    completion: "handoff",
    command: expect.stringContaining("visp pr"),
    objective: expect.stringContaining(ODD),
  });
  const report = await runProductReport(await state(), { feature });
  expect(report.ok && report.value.markdown).toContain("needs the human reviewer");
});

it("points next at acceptance after closing with an upheld ruling", async () => {
  const fixture = await disputeWorkspace();
  const { host } = reviewer(upholdAll);
  const done = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.next).toMatchObject({
    action: "accept",
    command: expect.stringContaining("visp accept"),
  });
  const next = await runProductNext(await state(), {
    feature: fixture.brief.feature,
    task: "T001",
  });
  expect(next.ok && next.value.action).toBe("accept");
});

it("resists re-rolling: at most two filings per test, prior rulings reach the reviewer", async () => {
  const fixture = await disputeWorkspace();
  const { host, packets } = reviewer(rejectAll);
  const file = async () =>
    runProductDoneReviewed(
      await state(),
      { task: "T001", dispute: [ODD], disputeReason: REASON },
      inlineReview(host),
    );
  const first = await file();
  expect(first.ok && first.value.pinnedTests?.disputes?.[0]?.status, JSON.stringify(first)).toBe(
    "rejected",
  );
  await workspace?.write("src/value.mjs", "// one\nexport const value = 2;\n");
  const second = await file();
  expect(second.ok && second.value.pinnedTests?.filed?.[0]?.status).toBe("filed");
  // The second reviewer sees the first ruling next to the new filing.
  expect(packets[1]?.disputes?.[0]?.priorRulings).toEqual([
    expect.objectContaining({ ruling: "rejected" }),
  ]);
  await workspace?.write("src/value.mjs", "// two\nexport const value = 2;\n");
  const third = await file();
  expect(third.ok && third.value.pinnedTests?.filed?.[0]).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("disputed 2 times"),
  });
  expect(host.review).toHaveBeenCalledTimes(2);
  const [entry] = await disputes(await state(), fixture.brief.feature);
  expect(entry).toMatchObject({ status: "rejected", filings: 2 });
});

it("refreshes an open dispute to the current failing run, or expires it when the test passes", async () => {
  const fixture = await disputeWorkspace({ maxCalls: 6 });
  const feature = fixture.brief.feature;
  const { host } = reviewer(() => []);
  await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  const [before] = await disputes(await state(), feature);
  expect(before).toMatchObject({ status: "open", reviews: 1 });
  // The source changes and the test still fails: the dispute now describes the new run.
  await workspace?.write("src/value.mjs", "// changed\nexport const value = 2;\n");
  await runProductDoneReviewed(await state(), { task: "T001" });
  const [refreshed] = await disputes(await state(), feature);
  expect(refreshed?.subject).not.toBe(before?.subject);
  expect(refreshed).toMatchObject({ status: "open", reviews: 0 });
  // The source changes again and the test passes: nothing is left to rule on.
  await workspace?.write("src/value.mjs", "export const value = 3;\n");
  await runProductDoneReviewed(await state(), { task: "T001" });
  const [expired] = await disputes(await state(), feature);
  expect(expired?.status).toBe("expired");
});

async function editDisputes(
  feature: string,
  edit: (entries: Record<string, unknown>[]) => Record<string, unknown>[],
) {
  const path = await recordPath(feature);
  const record = JSON.parse(await readFile(path, "utf8"));
  record.disputes = edit(record.disputes);
  await workspace?.write(
    `.visp/features/${feature}/acceptance-tests.json`,
    JSON.stringify(record, null, 2),
  );
}

it("lets a test be filed again when its upheld ruling does not verify", async () => {
  const fixture = await disputeWorkspace();
  const feature = fixture.brief.feature;
  const input = { task: "T001", dispute: [ODD], disputeReason: REASON };
  await runProductDoneReviewed(await state(), input);
  await editDisputes(feature, (entries) =>
    entries.map((entry) => ({
      ...entry,
      status: "upheld",
      ruling: {
        ruling: "upheld",
        reasoning: "not in the critic state",
        at: new Date().toISOString(),
        subject: entry.subject,
        attempt: "00000000-0000-4000-8000-000000000000",
        evidence: "made-up",
      },
    })),
  );
  const again = await runProductDoneReviewed(await state(), input);
  expect(again.ok && again.value.pinnedTests?.filed?.[0], JSON.stringify(again)).toMatchObject({
    status: "filed",
  });
  expect(await disputes(await state(), feature)).toEqual([
    expect.objectContaining({ status: "open" }),
  ]);
});

it("does not count a run with an uncaught error as all-waived or all-disputed", async () => {
  const declaredNames = ["a", "b"];
  const fail = "FAIL: a: expected 1";
  const waivers = { names: ["a"], declared: declaredNames, suiteSkips: false };
  expect(waivedFailure(fail, waivers)).toBe(true);
  for (const noise of [
    "Traceback (most recent call last):\n  File x.py",
    "Uncaught TypeError: x is undefined",
    "Error: ENOTEMPTY: directory not empty, rmdir '/tmp/profile'",
    "AssertionError [ERR_ASSERTION]: boom",
    "    at file:///tmp/suite.mjs:9:1",
  ]) {
    expect(waivedFailure(`${fail}\n${noise}`, waivers), noise).toBe(false);
    expect(allFailuresIn(`${fail}\n${noise}`, declaredNames, ["a"]), noise).toBe(false);
  }
  // A reason on a FAIL line may mention an error; a non-zero exit with no FAIL line is no test.
  expect(allFailuresIn("FAIL: a: TypeError: nope", declaredNames, ["a"])).toBe(true);
  expect(allFailuresIn("exit 1, no FAIL line", declaredNames, ["a"])).toBe(false);
});

it("attributes FAIL lines to declared tests without counting uncaught errors", () => {
  const declared = ["a", "a longer name", "b"];
  expect(failLineStats("FAIL: a: nope\nFAIL: a longer name: also\n  FAIL: B", declared)).toEqual({
    named: ["a", "a longer name", "b"],
    undeclared: [],
  });
  // unittest's own output names methods, not declared tests; stack lines are ignored.
  expect(
    failLineStats(
      "FAIL: test_x (C.test_x)\nTraceback (most recent call last):\n    at file:///x.mjs:1:1\nFAIL: a: bad",
      declared,
    ),
  ).toEqual({ named: ["a"], undeclared: [] });
  expect(failLineStats("FAIL: test_x (C.test_x): boom", declared).undeclared).toEqual([
    "test_x (C.test_x): boom",
  ]);
  // CRLF output, as Python prints it on Windows.
  expect(failLineStats("FAIL: a: nope\r\nFAIL: b\r\nFAIL: c: x\r\n", declared)).toEqual({
    named: ["a", "b"],
    undeclared: ["c: x"],
  });
  expect(failingTests("FAIL: a: nope\r\nFAIL: b\r\n", declared)).toEqual({
    names: ["a", "b"],
    unattributed: 0,
  });
  expect(failLineStats("Error: import failed\nexit 1", declared)).toEqual({
    named: [],
    undeclared: [],
  });
});

it("finds the message of an ENVIRONMENT ERROR line only at the start of a line", () => {
  expect(environmentErrorLine("ok\n  ENVIRONMENT ERROR: Chrome not found\nexit")).toBe(
    "Chrome not found",
  );
  expect(environmentErrorLine("ENVIRONMENT ERROR:")).toBe("no message");
  expect(environmentErrorLine("FAIL: a: ENVIRONMENT ERROR: x")).toBeUndefined();
  expect(environmentErrorLine("environment error: x")).toBeUndefined();
});

it("takes an environment error alone as such only without any failing test or trace", () => {
  const declared = ["a"];
  expect(environmentOnly("ENVIRONMENT ERROR: no Chrome\nexit", declared)).toBe(true);
  expect(environmentOnly("ok\r\nENVIRONMENT ERROR: no Chrome\r\n", declared)).toBe(true);
  expect(environmentOnly("exit 1", declared)).toBe(false);
  for (const other of [
    "FAIL: a: broke",
    "FAIL: something else: broke",
    "Traceback (most recent call last):",
    "TypeError: boom",
    "    at file:///x.mjs:1:1",
  ])
    expect(environmentOnly(`ENVIRONMENT ERROR: no Chrome\n${other}`, declared), other).toBe(false);
});

it("keeps the reviewer away when a disputed run also crashes outside its tests", async () => {
  const noisy: IndependentTester = async () => ({
    file: {
      name: "value.test.mjs",
      content: `${buildSuite(CHECKS)}console.log("Error: ENOTEMPTY: directory not empty");\nprocess.exitCode = 1;\n`,
    },
    tests: CHECKS.map(([name]) => ({ name, quote: "Return two" })),
    notes: "",
  });
  const fixture = await productWorkspace({ critic: true });
  workspace = fixture.workspace;
  const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  await workspace.write("visp.yml", stringify(config));
  workspace.commit("VISP launches the reviewer and tester");
  const work = await runProductWork(await workspace.state(), { task: "T001" }, inlineTests(noisy));
  expect(work.ok && work.value.independentTests?.status, JSON.stringify(work)).toBe("pinned");
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const starter = vi.fn(async () => ({ reviewed: true, findings: [] }));
  const done = await runProductDoneReviewed(
    await workspace.state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    starter,
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(starter).not.toHaveBeenCalled();
});

it("hands off only when every failing test is handed off or waived", async () => {
  const fixture = await disputeWorkspace({ checks: TWO_WRONG });
  const feature = fixture.brief.feature;
  const { host } = reviewer(() => []);
  const both = { task: "T001", dispute: WRONG.slice(), disputeReason: REASON };
  await runProductDoneReviewed(await state(), both, inlineReview(host));
  // Only one of the two failing tests is handed off: the other still needs a fix.
  await editDisputes(feature, (entries) =>
    entries.map((entry) => ({ ...entry, reviews: entry.test === ODD ? 2 : 0 })),
  );
  const partial = await runProductNext(await state(), { feature, task: "T001" });
  expect(partial.ok && partial.value.action).toBe("fix");
  expect(partial.ok && partial.value.completion).not.toBe("handoff");
  await editDisputes(feature, (entries) => entries.map((entry) => ({ ...entry, reviews: 2 })));
  const all = await runProductNext(await state(), { feature, task: "T001" });
  expect(all.ok && all.value).toMatchObject({
    completion: "handoff",
    command: expect.stringContaining("visp pr"),
  });
});

// What codexExecCriticHost is: capabilities come from inspect, so VISP's own attempts are native.
function launched(host: { review: (packet: CriticPacket) => Promise<unknown> }) {
  return {
    inspect: async () => ({
      harness: "codex" as const,
      model: NATIVE.model,
      reasoningEffort: "high" as const,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    }),
    review: async (packet: CriticPacket) => ({
      context: "fresh" as const,
      ...((await host.review(packet)) as object),
    }),
  } as unknown as Parameters<typeof inlineReview>[0];
}

it("hands a pending dispute to the human reviewer once the reviewer's calls are spent", async () => {
  const fixture = await disputeWorkspace({ maxCalls: 1 });
  const feature = fixture.brief.feature;
  const { host } = reviewer(() => []);
  // The one review the feature may spend leaves the dispute unruled and open.
  const first = await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(first.value.pinnedTests?.disputes?.[0]?.note).toContain("cannot rule on this");
  expect(first.value.pinnedTests?.disputes?.[0]?.note).toContain("visp pr");
  const next = await runProductNext(await state(), { feature, task: "T001" });
  expect(next.ok && next.value).toMatchObject({
    completion: "handoff",
    command: expect.stringContaining("visp pr"),
    objective: expect.stringContaining("cannot rule on the dispute"),
  });
});

it("refuses to file a dispute when no reviewer can rule on it", async () => {
  const fixture = await disputeWorkspace({ maxCalls: 1 });
  const { host } = reviewer(() => []);
  const input = { task: "T001", dispute: [ODD], disputeReason: REASON };
  await runProductDoneReviewed(await state(), input, inlineReview(host));
  const refused = await runProductDoneReviewed(await state(), input, inlineReview(host));
  expect(refused).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("No independent reviewer can rule on it") },
  });
  expect(await disputes(await state(), fixture.brief.feature)).toEqual([
    expect.objectContaining({ status: "open" }),
  ]);
});

it("hands a pending dispute over after the launched reviewer failed twice on this source", async () => {
  const fixture = await disputeWorkspace({ native: true });
  const feature = fixture.brief.feature;
  const crashing = launched({
    review: vi.fn(async () => {
      throw new Error("codex exec crashed");
    }),
  });
  const input = { task: "T001", dispute: [ODD], disputeReason: REASON };
  await runProductDoneReviewed(await state(), input, inlineReview(crashing));
  const once = await runProductNext(await state(), { feature, task: "T001" });
  expect(once.ok && once.value.completion).not.toBe("handoff");
  await runProductDoneReviewed(await state(), { task: "T001" }, inlineReview(crashing));
  const twice = await runProductNext(await state(), { feature, task: "T001" });
  expect(twice.ok && twice.value).toMatchObject({
    completion: "handoff",
    command: expect.stringContaining("visp pr"),
    objective: expect.stringContaining("cannot rule on the dispute"),
  });
  // Another edit gives VISP's reviewer a fresh source, so the dispute waits for it again.
  await workspace?.write("src/value.mjs", "export const value = 2; // edited\n");
  await runProductDoneReviewed(await state(), { task: "T001" });
  const changed = await runProductNext(await state(), { feature, task: "T001" });
  expect(changed.ok && changed.value.completion).not.toBe("handoff");
});

it("tells the worker no dispute can be ruled once VISP's reviewer cannot run again", async () => {
  const fixture = await disputeWorkspace({ maxCalls: 1 });
  const { host } = reviewer(() => []);
  // A dispute the reviewer leaves unruled spends the feature's only call.
  await runProductDoneReviewed(
    await state(),
    { task: "T001", dispute: [ODD], disputeReason: REASON },
    inlineReview(host),
  );
  const done = await runProductDoneReviewed(await state(), { task: "T001" });
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  const hint = done.value.pinnedTests?.hint ?? "";
  expect(hint).toContain("cannot rule on a dispute now");
  expect(hint).toContain("visp pr");
  expect(hint).toContain("Keep the product as the request says");
  expect(hint).not.toContain("--dispute");
  const next = await runProductNext(await state(), {
    feature: fixture.brief.feature,
    task: "T001",
  });
  expect(next.ok && next.value.evidence.join("\n")).toContain("cannot rule on a dispute now");
});
