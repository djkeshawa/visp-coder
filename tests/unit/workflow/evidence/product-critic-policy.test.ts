import { readFile, writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import { registerScopeTools } from "../../../../src/mcp/tools/scope.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
} from "../../../../src/workflow/product/index.js";
import { productStatePath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const config = balancedCritic("codex");
if (!config) throw new Error("missing preset");
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const run = async (input: object) => runProductCritic(await setup.workspace.state(), input);
const policy = (enabled: boolean, extra: object = {}) =>
  run({ operation: "set-policy", enabled, ...extra });
const record = async () => value(await readProductRecord(await setup.workspace.state()));

async function observed() {
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(
    value(await runProductVerify(await setup.workspace.state(), { task: "T001" })).passed,
  ).toBe(true);
}
async function reserve() {
  value(await policy(true, { harness: "codex" }));
  await observed();
  const result = value(await run({ operation: "prepare", task: "T001", capabilities })) as {
    attempt: string;
    expiresAt: number;
    packetPath: string;
  };
  return result;
}
async function submitFailure(attempt: string) {
  return run({
    operation: "submit",
    task: "T001",
    result: {
      attempt,
      model: capabilities.model,
      reasoningEffort: "high",
      context: "fresh",
      failure: "The host reviewer became unavailable",
    },
  });
}

it("defaults on with an unknown host, keeps setup unresolved, and records explicit opt-out provenance", async () => {
  const initial = await record();
  expect(initial.state).toMatchObject({ criticEnabled: true });
  expect(initial.state.criticDefault).toBeUndefined();
  const preflight = await run({ operation: "preflight" });
  expect(preflight).toMatchObject({
    ok: true,
    value: { ready: false, gaps: [expect.stringContaining("Setup is incomplete")] },
  });
  expect((await record()).stateText).toBe(initial.stateText);
  value(await policy(false, { reason: "User requested no critic for this feature" }));
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { enabled: false } });
  const disabled = await record();
  expect(disabled.state.criticPolicyChanges).toEqual([
    {
      enabled: false,
      createdAt: expect.any(String),
      provenance: "caller-reported",
      reason: "User requested no critic for this feature",
    },
  ]);
  expect(disabled.state.executions).toEqual(initial.state.executions);
  expect(disabled.state.reviews).toEqual(initial.state.reviews);
  expect(await policy(false)).toMatchObject({ ok: true, value: { unchanged: true } });
  expect((await record()).stateText).toBe(disabled.stateText);
  value(await policy(true));
  await observed();
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: {
      action: "implement",
      mayEdit: true,
      criticAdvice: { guidance: expect.stringContaining("Setup is incomplete") },
    },
  });
});

it("preserves spent attempts, candidate bytes and evidence across feature off/on", async () => {
  const prepared = await reserve();
  expect(await submitFailure(prepared.attempt)).toMatchObject({
    ok: true,
    value: { action: "unresolved", callsUsed: 1 },
  });
  const workspace = await setup.workspace.state();
  const selected = value(await criticSelection(workspace, { task: "T001" }));
  const before = value(await readCriticState(workspace, selected));
  const status = value(await run({ operation: "status", task: "T001" })) as {
    candidates: { path: string }[];
  };
  const candidatePath = status.candidates[0]?.path;
  if (!candidatePath) throw new Error("missing candidate");
  const candidate = await readFile(candidatePath);
  const packet = await readFile(prepared.packetPath);
  const product = await record();
  value(await policy(false));
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { enabled: false, callsUsed: 1 },
  });
  expect(await run({ operation: "prepare", task: "T001", capabilities })).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED" },
  });
  value(await policy(true));
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { enabled: true, callsUsed: 1, callsRemaining: 2 },
  });
  expect(await readFile(selected.path, "utf8")).toBe(before.text);
  expect(await readFile(candidatePath)).toEqual(candidate);
  expect(await readFile(prepared.packetPath)).toEqual(packet);
  const after = await record();
  expect(after.state.executions).toEqual(product.state.executions);
  expect(after.state.reviews).toEqual(product.state.reviews);
  expect(after.briefText).toBe(product.briefText);
  expect(await policy(true, { harness: "cursor" })).toMatchObject({
    ok: false,
    error: { code: "CONFIG_INVALID" },
  });
  expect((await record()).stateText).toBe(after.stateText);
});

it("does not report a selection disabled when an unknown reviewer host has no selection state", async () => {
  const before = await record();
  expect(await run({ operation: "disable", task: "T001" })).toMatchObject({
    ok: false,
    error: { code: "WORKFLOW_REPLACED" },
  });
  expect((await record()).stateText).toBe(before.stateText);
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { enabled: true, gaps: [expect.stringContaining("Setup is incomplete")] },
  });
});

it("blocks switches during a pending native attempt and retains the reservation after its deadline", async () => {
  const prepared = await reserve();
  const before = await record();
  for (const enabled of [false, true]) {
    expect(await policy(enabled)).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
    expect((await record()).stateText).toBe(before.stateText);
  }
  value(await run({ operation: "set-policy", mode: "both" }));
  expect((await record()).state.criticManual).toBe(true);
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1 },
  });
  expect(await run({ operation: "set-policy", mode: "manual" })).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY" },
  });
  vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt + 1);
  value(await policy(false));
  value(await policy(true));
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { enabled: true, callsUsed: 1, stopped: expect.stringContaining("interrupted-review") },
  });
});

it("pauses product mutations and the CLI guard while a native review is pending", async () => {
  await reserve();
  const workspace = await setup.workspace.state();
  expect(await runProductWork(workspace, { task: "T001" })).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
  });
  expect(await runProductDone(workspace, { task: "T001" })).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
  });
  expect(await runProductAccept(workspace)).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
  });

  const guarded = await runJson<{ allowed: boolean; violations: { reason: string }[] }>(
    setup.workspace.root,
    "guard",
    "--path",
    "src/value.mjs",
  );
  expect(guarded.exitCode).not.toBe(0);
  expect(guarded.envelope.data).toMatchObject({
    allowed: false,
    violations: [expect.objectContaining({ reason: "review-pending" })],
  });

  let scopeGuard: ((args: { paths: string[] }) => Promise<CallToolResult>) | undefined;
  registerScopeTools(
    {
      registerTool: (_name: string, _config: unknown, callback: unknown) => {
        scopeGuard = callback as (args: { paths: string[] }) => Promise<CallToolResult>;
        return {};
      },
    } as unknown as McpServer,
    setup.workspace.root,
  );
  const mcpGuard = await scopeGuard?.({ paths: ["src/value.mjs"] });
  expect(mcpGuard?.structuredContent).toMatchObject({
    data: {
      allowed: false,
      violations: [expect.objectContaining({ reason: "review-pending" })],
    },
  });
});

it("does not let --if-authorized bypass a pending review before the first work marker", async () => {
  value(await policy(true, { harness: "codex" }));
  expect(
    await run({ operation: "prepare", task: "T001", phase: "understanding", capabilities }),
  ).toMatchObject({ ok: true });

  const guarded = await runJson<{ allowed: boolean; violations: { reason: string }[] }>(
    setup.workspace.root,
    "guard",
    "--if-authorized",
    "--path",
    "src/value.mjs",
  );
  expect(guarded.exitCode).not.toBe(0);
  expect(guarded.envelope.data).toMatchObject({
    allowed: false,
    violations: [expect.objectContaining({ reason: "review-pending" })],
  });
});

it("reconciles a legacy task disable without resetting spent calls or changing feature policy", async () => {
  const prepared = await reserve();
  value(await submitFailure(prepared.attempt));
  const selected = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
  const saved = JSON.parse(await readFile(selected.path, "utf8"));
  await writeFile(selected.path, JSON.stringify({ ...saved, disabled: true }));
  expect(await run({ operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { enabled: true, next: "unresolved" },
  });
  value(
    await run({
      operation: "reconcile",
      task: "T001",
      reason: "Repair legacy task policy conflict",
    }),
  );
  expect(JSON.parse(await readFile(selected.path, "utf8"))).toMatchObject({
    disabled: false,
    attempts: saved.attempts,
  });
  expect((await record()).state.criticEnabled).toBe(true);
});

it("enables advice without reopening accepted work or changing review records", async () => {
  value(await policy(false));
  await observed();
  expect(value(await runProductDone(await setup.workspace.state(), { task: "T001" })).closed).toBe(
    true,
  );
  const bundle = value(await runProductReview(await setup.workspace.state()));
  value(
    await runProductReview(await setup.workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      reviewer: { context: "current" },
      feedback: moduleFeedback(bundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Executed the public module",
          evidence: ["C001"],
        },
      ],
    }),
  );
  expect(value(await runProductAccept(await setup.workspace.state())).passed).toBe(true);
  const accepted = await record();
  expect(accepted.state.status).toBe("accepted");
  value(await policy(true, { harness: "codex" }));
  const reopened = await record();
  expect(reopened.state.status).toBe("accepted");
  expect(reopened.state.acceptedSubject).toBe(accepted.state.acceptedSubject);
  expect(reopened.state.executions).toEqual(accepted.state.executions);
  expect(reopened.state.reviews).toEqual(accepted.state.reviews);
  expect(reopened.state.slices).toEqual(accepted.state.slices);
  expect(value(await runProductAccept(await setup.workspace.state())).passed).toBe(true);
});

it("keeps an already-enabled accepted feature idempotent and never reopens historical completion", async () => {
  value(await policy(true, { harness: "codex" }));
  const workspace = await setup.workspace.state();
  const loaded = await record();
  const path = productStatePath(workspace, setup.brief.feature);
  await writeFile(path, JSON.stringify({ ...loaded.state, status: "accepted" }));
  const accepted = await readFile(path, "utf8");
  expect(await policy(true)).toMatchObject({ ok: true, value: { unchanged: true } });
  expect(await readFile(path, "utf8")).toBe(accepted);
  value(await run({ operation: "set-policy", mode: "both" }));
  expect((await record()).state).toMatchObject({ status: "accepted", criticManual: true });
  value(await run({ operation: "configure", config }));
  await writeFile(path, JSON.stringify({ ...loaded.state, status: "historical-complete" }));
  const historical = await readFile(path, "utf8");
  for (const enabled of [true, false]) {
    expect(await policy(enabled)).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
    expect(await readFile(path, "utf8")).toBe(historical);
  }
  const selected = value(await criticSelection(await setup.workspace.state(), {}));
  const criticBefore = await readFile(selected.path, "utf8");
  for (const request of [
    { operation: "configure", config },
    { operation: "disable" },
    { operation: "prepare", capabilities },
    {
      operation: "restore",
      candidate: `CAN-${"a".repeat(32)}`,
      expectedSubject: "a".repeat(64),
    },
    {
      operation: "submit",
      result: {
        attempt: "00000000-0000-4000-8000-000000000001",
        model: config.model,
        context: "fresh",
        failure: "Historical results cannot be submitted",
      },
    },
  ]) {
    expect(await run(request)).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
  }
  const review = vi.fn();
  expect(
    await runProductCritic(await setup.workspace.state(), { operation: "review" }, { review }),
  ).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
  expect(review).not.toHaveBeenCalled();
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { enabled: false },
  });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, gaps: [expect.stringContaining("Historical")] },
  });
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { action: "complete", mayEdit: false },
  });
  expect(await readFile(path, "utf8")).toBe(historical);
  expect(await readFile(selected.path, "utf8")).toBe(criticBefore);
});

it("refuses policy mutation when saved critic state is malformed", async () => {
  value(await policy(true, { harness: "codex" }));
  value(await run({ operation: "configure", task: "T001", config }));
  const selected = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
  await writeFile(selected.path, JSON.stringify({ version: 1, attempts: [] }));
  const before = await record();
  expect(await policy(false)).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  expect((await record()).stateText).toBe(before.stateText);
});

it("does not treat turning the critic off as passing behavioral checks", async () => {
  value(await policy(false));
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
  const done = value(await runProductDone(await setup.workspace.state(), { task: "T001" }));
  expect(done).toMatchObject({ passed: false, closed: false });
  expect(done.executions).toEqual([expect.objectContaining({ check: "C001", status: "failed" })]);
  expect((await record()).state.slices.T001?.status).not.toBe("closed");
});

it("keeps required review findings blocking completion after opting out of the critic", async () => {
  await observed();
  const bundle = value(await runProductReview(await setup.workspace.state(), { task: "T001" }));
  const feedback = moduleFeedback(bundle);
  feedback.findings.push({
    dimension: "functional",
    problem: "Repeated reads have not been checked",
    nextCheck: "Import twice and compare both public values",
    outcomes: ["O001"],
    required: true,
    evidence: [],
  });
  value(
    await runProductReview(await setup.workspace.state(), {
      task: "T001",
      subjectDigest: bundle.subjectDigest,
      reviewer: { context: "current" },
      feedback,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Executed the public module",
          evidence: ["C001"],
        },
      ],
    }),
  );
  const before = await record();
  value(await policy(false));
  expect((await record()).state.reviews).toEqual(before.state.reviews);
  const done = value(await runProductDone(await setup.workspace.state(), { task: "T001" }));
  expect(done).toMatchObject({ passed: false, closed: false });
  expect(done.gaps).toContainEqual(expect.stringContaining("Repeated reads have not been checked"));
});
