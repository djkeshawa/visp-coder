import { afterEach, beforeEach, expect, it } from "vitest";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  runProductDone,
  runProductNext,
  runProductStatus,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { runProductWork as startBeforeCritic } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  const work = await startBeforeCritic(await setup.workspace.state(), { task: "T001" });
  if (!work.ok) throw new Error(work.error.message);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const configured = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "configure",
    config: {
      model: "test-critic",
      harness: "codex",
      transport: "native",
      maxCalls: 2,
      timeoutMs: 5000,
      maxImageBytes: 1048576,
    },
  });
  if (!configured.ok) throw new Error(configured.error.message);
});
afterEach(async () => {
  await setup.workspace.destroy();
});

it("verification offers critic feedback alongside baseline navigation", async () => {
  const verified = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  expect(verified).toMatchObject({
    ok: true,
    value: {
      next: {
        action: "implement",
        criticAdvice: { command: expect.stringContaining("visp critic") },
      },
      nextCommand: expect.stringContaining("visp done"),
    },
  });
  const status = await runProductStatus(await setup.workspace.state(), { task: "T001" });
  const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
  if (!status.ok || !next.ok) throw new Error("Expected status and next");
  expect(status.value.state?.reviews).toEqual([]);
  expect(status.value.next).toEqual(next.value);
  expect(status.value.report).toContain(next.value.command);
  const critic = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "status",
  });
  expect(critic).toMatchObject({ ok: true, value: { callsUsed: 0 } });
});

it("done closes tested behavior and schedules baseline host review with optional critic advice", async () => {
  const done = await runProductDone(await setup.workspace.state(), { task: "T001" });
  expect(done).toMatchObject({
    ok: true,
    value: {
      closed: true,
      passed: true,
      next: {
        action: "refine",
        command: expect.stringContaining("visp review"),
        criticAdvice: { command: expect.stringContaining("visp critic") },
      },
      nextCommand: expect.stringContaining("visp review"),
    },
  });
});

it("a failing behavior still routes to implementation before spending a critic call", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 1;\n");
  expect(await runProductVerify(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: {
      passed: false,
      next: { action: "fix", command: expect.stringContaining("visp work") },
    },
  });
});

it("another slice's checks do not schedule a product critic before the selected slice is observed", async () => {
  const original = setup.brief.slices[0];
  const check = setup.brief.checks[0];
  if (!original || !check) throw new Error("Missing fixture slice");
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      checks: [...setup.brief.checks, { ...check, id: "C002" }],
      slices: [...setup.brief.slices, { ...original, id: "T002", checks: ["C002"] }],
    },
    reason: "Add an independent slice and its own check",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await startBeforeCritic(await setup.workspace.state(), { task: "T001" });
  await runProductVerify(await setup.workspace.state(), { task: "T001" });
  const worked = await startBeforeCritic(await setup.workspace.state(), { task: "T002" });
  if (!worked.ok) throw new Error(worked.error.message);
  expect(
    await runProductCritic(await setup.workspace.state(), { task: "T002", operation: "status" }),
  ).toMatchObject({ ok: true, value: { hasObservedProduct: false } });
  expect(await runProductNext(await setup.workspace.state(), { task: "T002" })).toMatchObject({
    ok: true,
    value: { action: "implement", command: expect.stringContaining("visp done") },
  });
});

it("a shared check executed for one slice does not mark the other slice observed", async () => {
  const original = setup.brief.slices[0];
  if (!original) throw new Error("Missing fixture slice");
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      slices: [...setup.brief.slices, { ...original, id: "T002" }],
    },
    reason: "Add another slice that shares the check",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await startBeforeCritic(await setup.workspace.state(), { task: "T001" });
  const verified = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  if (!verified.ok) throw new Error(verified.error.message);
  const worked = await startBeforeCritic(await setup.workspace.state(), { task: "T002" });
  if (!worked.ok) throw new Error(worked.error.message);
  expect(
    await runProductCritic(await setup.workspace.state(), { task: "T002", operation: "status" }),
  ).toMatchObject({ ok: true, value: { hasObservedProduct: false } });
});
