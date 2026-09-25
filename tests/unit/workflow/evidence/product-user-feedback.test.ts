import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { runProductVerify } from "../../../../src/workflow/product/index.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { productStatePath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceDigest } from "../../../../src/workflow/product/subject.js";
import { runProductUserFeedback } from "../../../../src/workflow/product/user-feedback.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let p: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  p = await productWorkspace({ critic: true });
});
afterEach(async () => {
  await p.workspace.destroy();
});
const state = () => p.workspace.state();
const run = async (input: Record<string, unknown>) =>
  runProductUserFeedback(await state(), { task: "T001", ...input });
async function manual(mode = "manual") {
  expect(await runProductCritic(await state(), { operation: "set-policy", mode })).toMatchObject({
    ok: true,
  });
}
async function record() {
  const result = await readProductRecord(await state());
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it("keeps manual opt-in and configures auto, manual, both and off without resetting model history", async () => {
  expect(await run({ operation: "ask", question: "How does it feel?" })).toMatchObject({
    ok: false,
  });
  for (const [mode, automatic, user] of [
    ["manual", false, true],
    ["both", true, true],
    ["auto", true, false],
    ["off", false, false],
  ] as const) {
    await manual(mode);
    expect((await record()).state).toMatchObject({ criticEnabled: automatic, criticManual: user });
  }
  expect(
    await runProductCritic(await state(), {
      operation: "set-policy",
      mode: "manual",
      enabled: true,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await runProductCritic(await state(), { operation: "status", mode: "both" }),
  ).toMatchObject({ ok: false });
});

it("offers a mid-flight question after an observed slice, without blocking work or creating passing evidence", async () => {
  await manual();
  expect(await runProductWork(await state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  await p.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(await runProductVerify(await state(), { task: "T001" })).toMatchObject({ ok: true });
  const before = await record();
  const subject = await productSourceDigest(await state(), before.brief);
  const next = await runProductNext(await state());
  expect(next).toMatchObject({
    ok: true,
    value: {
      userFeedback: { status: "suggested", command: expect.stringContaining("critic feedback") },
    },
  });
  const asked = await run({
    operation: "ask",
    question: "Is this the behavior you wanted?",
    context: "The public module now returns two.",
  });
  expect(asked).toMatchObject({
    ok: true,
    value: { status: "pending", delivery: "native-handoff" },
  });
  if (!asked.ok) throw new Error(asked.error.message);
  const id = (asked.value as { id: string }).id;
  expect(await run({ operation: "ask", question: "A duplicated prompt" })).toMatchObject({
    ok: true,
    value: { id, dispatch: false },
  });
  expect(await runProductWork(await state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true, userFeedback: { status: "pending" } },
  });
  expect(
    await run({ operation: "reply", id, reply: "Yes, but the name should be clearer." }),
  ).toMatchObject({ ok: true, value: { status: "answered", provenance: "caller-reported" } });
  const after = await record();
  expect(after.state.reviews).toEqual(before.state.reviews);
  expect(after.state.executions).toEqual(before.state.executions);
  expect(after.brief).toEqual(before.brief);
  expect(await productSourceDigest(await state(), after.brief)).toEqual(subject);
  expect(await runProductWork(await state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: {
      userFeedback: {
        feedback: [{ reply: "Yes, but the name should be clearer.", current: true }],
      },
    },
  });
});

it("elicits once outside the mutation lock and preserves feedback about a changed product as stale context", async () => {
  await manual();
  const host = {
    ask: vi.fn(async () => {
      expect(await runProductWork(await state(), { task: "T001" })).toMatchObject({ ok: true });
      await p.workspace.write("src/value.mjs", "export const value = 3;\n");
      return { action: "answer" as const, text: "The version I saw was too small." };
    }),
  };
  expect(
    await runProductUserFeedback(
      await state(),
      { operation: "ask", task: "T001", question: "What should improve?" },
      host,
    ),
  ).toMatchObject({ ok: true, value: { status: "answered", provenance: "host-elicited" } });
  expect(host.ask).toHaveBeenCalledTimes(1);
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { feedback: [{ current: false, reply: "The version I saw was too small." }] },
  });
});

it("keeps interrupted delivery pending without re-prompting or inventing a user answer", async () => {
  await manual();
  const controller = new AbortController();
  const host = {
    ask: vi.fn(async () => {
      controller.abort();
      return new Promise<never>(() => {});
    }),
  };
  const result = await runProductUserFeedback(
    await state(),
    { operation: "ask", task: "T001", question: "Which direction is useful?" },
    host,
    controller.signal,
  );
  expect(result).toMatchObject({
    ok: true,
    value: { status: "pending", deliveryIssue: expect.stringContaining("interrupted") },
  });
  await runProductUserFeedback(
    await state(),
    { operation: "ask", task: "T001", question: "Again?" },
    host,
  );
  expect(host.ask).toHaveBeenCalledTimes(1);
  expect((await record()).state.userFeedback?.[0]?.reply).toBeUndefined();
});

it("treats decline as deferral and keeps manual requests out of automatic call budgets", async () => {
  await manual("both");
  const before = await runProductCritic(await state(), { operation: "status", task: "T001" });
  expect(
    await runProductUserFeedback(
      await state(),
      { operation: "ask", task: "T001", question: "Any feedback?" },
      { ask: async () => ({ action: "defer" }) },
    ),
  ).toMatchObject({ ok: true, value: { status: "deferred" } });
  const after = await runProductCritic(await state(), { operation: "status", task: "T001" });
  expect(after).toEqual(before);
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { status: "deferred", command: undefined },
  });
});

it("rejects invalid selections and malformed replies before showing a popup or writing state", async () => {
  await manual();
  const before = await record();
  const host = { ask: vi.fn(async () => ({ action: "defer" as const })) };
  expect(
    await runProductUserFeedback(
      await state(),
      { operation: "ask", task: "T404", question: "Feedback?" },
      host,
    ),
  ).toMatchObject({ ok: false });
  for (const request of [
    { operation: "ask" },
    { operation: "reply", id: "invalid", reply: "yes" },
    { operation: "status", question: "Oops" },
    { operation: "defer" },
  ]) {
    expect(await run(request)).toMatchObject({ ok: false });
  }
  expect(host.ask).not.toHaveBeenCalled();
  expect((await record()).stateText).toEqual(before.stateText);
});

it("retains pending feedback across policy changes and rejects duplicate answers", async () => {
  await manual();
  const asked = await run({ operation: "ask", question: "Should this be larger?" });
  if (!asked.ok) throw new Error(asked.error.message);
  const id = (asked.value as { id: string }).id;
  await manual("off");
  expect(await run({ operation: "ask", question: "Again?" })).toMatchObject({ ok: false });
  expect(await run({ operation: "defer", id })).toMatchObject({
    ok: true,
    value: { status: "deferred" },
  });
  expect(await run({ operation: "reply", id, reply: "Overwrite" })).toMatchObject({ ok: false });
});

it("keeps an invalid host answer pending and never treats it as a skip or approval", async () => {
  await manual();
  const host = {
    ask: async () => ({ action: "approve" }),
  } as unknown as import("../../../../src/workflow/product/user-feedback.js").UserFeedbackHost;
  expect(
    await runProductUserFeedback(
      await state(),
      { operation: "ask", task: "T001", question: "Feedback?" },
      host,
    ),
  ).toMatchObject({ ok: true, value: { status: "pending", deliveryIssue: expect.any(String) } });
  expect((await record()).state.userFeedback?.[0]?.reply).toBeUndefined();
});

it("allows only one concurrent popup request and keeps feedback status read-only", async () => {
  await manual();
  const host = {
    ask: vi.fn(async () => {
      throw new Error("Host popup unavailable");
    }),
  };
  const results = await Promise.all(
    [0, 1].map(async () =>
      runProductUserFeedback(
        await state(),
        { operation: "ask", task: "T001", question: "Feedback?" },
        host,
      ),
    ),
  );
  expect(results.some((result) => result.ok)).toBe(true);
  expect(host.ask).toHaveBeenCalledOnce();
  const before = await record();
  await run({ operation: "status" });
  expect((await record()).stateText).toEqual(before.stateText);
});

it("does not dispatch cancelled requests or mutate historical features", async () => {
  await manual();
  const before = await record();
  const controller = new AbortController();
  controller.abort();
  const host = { ask: vi.fn(async () => ({ action: "defer" as const })) };
  const request = { operation: "ask", task: "T001", question: "Feedback?" };
  expect(
    await runProductUserFeedback(await state(), request, host, controller.signal),
  ).toMatchObject({ ok: false });
  expect((await record()).stateText).toEqual(before.stateText);
  const workspace = await state();
  await writeFile(
    productStatePath(workspace, p.brief.feature),
    JSON.stringify({ ...before.state, status: "historical-complete" }),
  );
  const historical = await record();
  expect(await runProductUserFeedback(await state(), request, host)).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED" },
  });
  expect((await record()).stateText).toEqual(historical.stateText);
  expect(host.ask).not.toHaveBeenCalled();
});
