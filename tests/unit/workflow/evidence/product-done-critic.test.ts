import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  backgroundReview,
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = { model: "test-critic", maxCalls: 3, timeoutMs: 5000, maxImageBytes: 4194304 };
let setup: Awaited<ReturnType<typeof productWorkspace>>;

function review(status: "satisfied" | "failed") {
  return (packet: CriticPacket) => ({
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((outcome) => ({
        outcome: outcome.id,
        status,
        summary:
          status === "satisfied"
            ? "Executed the module and observed the promised value"
            : "The module returns three, not the promised two",
        evidence: ["C001"],
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  });
}

function launcher(respond: (packet: CriticPacket) => unknown): ProductCriticHost {
  return { review: vi.fn(async (packet) => ({ model: config.model, response: respond(packet) })) };
}

beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  const state = await setup.workspace.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const configured = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "configure",
    config,
  });
  expect(configured.ok).toBe(true);
});
afterEach(async () => {
  await setup.workspace.destroy();
});

it("launches the configured critic once checks pass and returns its verdict", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(host.review).toHaveBeenCalledTimes(1);
  expect(done.value.critic).toMatchObject({ reviewed: true, findings: [] });
});

it("turns critic findings into the next repair step", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(launcher(review("failed"))),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.reviewed).toBe(true);
  expect(done.value.next?.action).toBe("fix");
});

it("does not launch the critic while checks fail", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok).toBe(true);
  expect(host.review).not.toHaveBeenCalled();
  if (done.ok) expect(done.value.critic).toBeUndefined();
});

it("reports a background review that finishes before it is ever pending", async () => {
  const cli = join(setup.workspace.root, ".visp", "fake-cli.mjs");
  await writeFile(
    cli,
    `process.stdout.write(JSON.stringify({ ok: true, data: { lifecycle: { acceptedReview: true }, findings: [{ problem: "Wrong status", nextCheck: "GET /x", required: true }] } }));\n`,
  );
  const summary = await backgroundReview(cli, 5000)(await setup.workspace.state(), {
    feature: setup.brief.feature,
  });
  expect(summary).toMatchObject({
    reviewed: true,
    findings: [{ problem: "Wrong status", nextCheck: "GET /x", required: true }],
  });
});

it("waits for a running review and reports its recorded state instead of a wait step", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const running = async () => ({ reviewed: false, running: true, findings: [] });
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    running,
    1000,
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.running).toBeUndefined();
  expect(done.value.next?.action).not.toBe("wait");
});

it("launches the critic when done closes on checks that already passed under verify", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(host.review).toHaveBeenCalledTimes(1);
});
