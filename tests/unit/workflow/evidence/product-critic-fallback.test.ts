import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const preset = balancedCritic("codex");
if (!preset) throw new Error("Missing preset");
const config = { ...preset, maxCalls: 2 };
if (!config) throw new Error("Missing preset");
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: config.reasoningEffort,
  freshContext: true,
  readOnly: true,
  images: false,
  delegationAllowed: true,
};
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});
const run = async (input: object) =>
  runProductCritic(await setup.workspace.state(), { task: "T001", ...input });
async function ready() {
  expect((await runProductWork(await setup.workspace.state())).ok).toBe(true);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await setup.workspace.state())).ok).toBe(true);
}

it("offers independent help with an observed failure while retaining the baseline fix action", async () => {
  expect((await runProductWork(await setup.workspace.state())).ok).toBe(true);
  expect((await run({ operation: "configure", config })).ok).toBe(true);
  // The real public-module check fails: this is useful critic input, not a readiness gate.
  const verification = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  expect(verification).toMatchObject({ ok: true, value: { passed: false } });
  const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
  expect(next).toMatchObject({
    ok: true,
    value: {
      action: "fix",
      criticAdvice: { status: "suggested", command: expect.stringContaining("--preflight") },
    },
  });
  expect(next.ok && next.value.command).not.toContain("visp critic");
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true, callsUsed: 0 },
  });
  expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { passed: false, closed: false },
  });
});

it.each(["unconfigured", "failed", "pending", "exhausted"])(
  "preserves baseline review and closeout when critic is %s",
  async (mode) => {
    await ready();
    let pendingAttempt: string | undefined;
    if (mode !== "unconfigured") {
      expect(
        (
          await run({
            operation: "configure",
            config: { ...config, maxCalls: mode === "exhausted" ? 1 : 2 },
          })
        ).ok,
      ).toBe(true);
      const prepared = await run({ operation: "prepare", capabilities });
      if (!prepared.ok) throw new Error(prepared.error.message);
      pendingAttempt = (prepared.value as { attempt: string }).attempt;
      if (mode !== "pending")
        expect(
          (
            await run({
              operation: "submit",
              attempt: (prepared.value as { attempt: string }).attempt,
              failure: "Host refused reviewer invocation",
              failureKind: "permission-denied",
              notInvoked: true,
            })
          ).ok,
        ).toBe(true);
    }
    const next = await runProductNext(await setup.workspace.state());
    expect(next).toMatchObject({ ok: true, value: { criticAdvice: { status: "unavailable" } } });
    expect(next.ok && next.value.command).not.toContain("visp critic");
    if (mode === "pending") {
      expect(await runProductDone(await setup.workspace.state())).toMatchObject({
        ok: false,
        error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
      });
      expect(
        await run({
          operation: "submit",
          attempt: pendingAttempt,
          failure: "Host refused reviewer invocation",
          failureKind: "permission-denied",
          notInvoked: true,
        }),
      ).toMatchObject({ ok: true, value: { callsUsed: 1 } });
    }
    // Missing service does not supply a passing product review.
    await runProductDone(await setup.workspace.state());
    expect(await runProductAccept(await setup.workspace.state())).toMatchObject({
      ok: true,
      value: { passed: false },
    });
    const bundle = await runProductReview(await setup.workspace.state());
    if (!bundle.ok) throw new Error(bundle.error.message);
    expect(
      (
        await runProductReview(await setup.workspace.state(), {
          subjectDigest: bundle.value.subjectDigest,
          assessments: [
            {
              outcome: "O001",
              status: "satisfied",
              summary: "Public value observed",
              evidence: ["C001"],
              expectations: [],
            },
          ],
          reviewer: { context: "current" },
          feedback: moduleFeedback(bundle.value),
        })
      ).ok,
    ).toBe(true);
    expect(await runProductAccept(await setup.workspace.state())).toMatchObject({
      ok: true,
      value: { passed: true },
    });
    const record = await readProductRecord(await setup.workspace.state());
    expect(record.ok && record.value.state.criticEnabled).toBe(true); // No silent opt-out.
  },
);

it("delivers source advice without image capability and cannot turn overconfident advice into approval", async () => {
  const brief = structuredClone(setup.brief);
  brief.goal = "Show the public value in a browser";
  const outcome = brief.outcomes[0];
  if (!outcome) throw new Error("Missing outcome");
  outcome.kind = "experience";
  outcome.reviewRequired = true;
  expect(
    (
      await updateProductBrief(await setup.workspace.state(), {
        brief,
        reason: "Review the visible result",
        intentChange: { reason: "Test fixture UI outcome", provenance: "test" },
      })
    ).ok,
  ).toBe(true);
  await ready();
  expect((await run({ operation: "configure", config })).ok).toBe(true);
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, callsUsed: 0 },
  });
  expect(await run({ operation: "preflight", sourceOnly: true, capabilities })).toMatchObject({
    ok: true,
    value: {
      ready: true,
      requiresImages: false,
      callsUsed: 0,
      prepareCommand: expect.stringContaining("--source-only"),
    },
  });
  const prepared = await run({ operation: "prepare", sourceOnly: true, capabilities });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const value = prepared.value as { attempt: string; packetPath: string };
  const packet = JSON.parse(await readFile(value.packetPath, "utf8"));
  expect(packet.sourceOnly).toBe(true);
  expect(packet.current.images).toEqual([]);
  const source = packet.current.sources.find(
    (s: { kind: string; available: boolean }) => s.kind === "implementation-file" && s.available,
  );
  const response = {
    summary: "Source reviewed",
    findings: [],
    limitations: [],
    resolutions: [],
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "Overconfident visual approval",
        evidence: [source.id],
        expectations: [],
      },
    ],
  };
  expect(
    await run({ operation: "submit", attempt: value.attempt, capabilities, response }),
  ).toMatchObject({
    ok: true,
    value: { sourceOnly: true, assessmentCurrent: false, callsUsed: 1 },
  });
  const record = await readProductRecord(await setup.workspace.state());
  if (!record.ok) throw new Error(record.error.message);
  expect(record.value.state.reviews.at(-1)?.assessments).toEqual([]);
  expect(await runProductDone(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { passed: false },
  });
  expect(await run({ operation: "prepare", sourceOnly: true, capabilities })).toMatchObject({
    ok: false,
  });
});

it("names deleted outside-scope inputs and never reports a scope rejection as a browser attempt", async () => {
  await setup.workspace.write("brief-input.json", "{}");
  await ready();
  await rm(`${setup.workspace.root}/brief-input.json`);
  expect(
    await runProductVerify(await setup.workspace.state(), { retryEnvironment: true }),
  ).toMatchObject({
    ok: false,
    error: {
      code: "SCOPE_VIOLATION",
      details: {
        deleted: ["brief-input.json"],
        executionAttempted: false,
        browserRetryAttempted: false,
      },
    },
  });
  await writeFile(`${setup.workspace.root}/brief-input.json`, "{}");
  expect(
    (await runProductVerify(await setup.workspace.state(), { retryEnvironment: true })).ok,
  ).toBe(true);
});

it("keeps a clean source consultation eligible for rendered feedback after browser recovery", async () => {
  await ready();
  expect((await run({ operation: "configure", config })).ok).toBe(true);
  const prepared = await run({ operation: "prepare", sourceOnly: true, capabilities });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const value = prepared.value as { attempt: string };
  expect(
    await run({
      operation: "submit",
      attempt: value.attempt,
      capabilities,
      response: {
        summary: "No source defect found; visual behavior remains unassessed",
        findings: [],
        assessments: [],
        resolutions: [],
        limitations: [],
      },
    }),
  ).toMatchObject({ ok: true, value: { assessmentCurrent: false, callsRemaining: 1 } });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { next: "review", sourceOnly: true, callsUsed: 1 },
  });
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { criticAdvice: { command: expect.stringContaining("--preflight") } },
  });
});
