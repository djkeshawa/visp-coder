import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  type ReviewStarter,
  reviewOwed,
  runProductDoneReviewed,
  skippableReview,
} from "../../../../src/workflow/product/done-review.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = { model: "test-critic", maxCalls: 5, timeoutMs: 5000, maxImageBytes: 4194304 };
let setup: Awaited<ReturnType<typeof productWorkspace>>;

function satisfied(packet: CriticPacket) {
  return {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((outcome) => ({
        outcome: outcome.id,
        status: "satisfied",
        summary: "Executed the module and observed the promised value",
        evidence: [
          packet.current.evidence.find(
            (entry) =>
              entry.kind === "execution" &&
              entry.status === "available" &&
              entry.outcomes.includes(outcome.id),
          )?.id ??
            packet.current.sources.find(
              (source) => source.kind === "implementation-file" && source.available,
            )?.id ??
            "SRC-REQUEST",
        ],
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  };
}
const host = (): ProductCriticHost => ({
  review: vi.fn(async (packet) => ({
    context: "fresh" as const,
    model: config.model,
    response: satisfied(packet),
  })),
});
const starter = () =>
  vi.fn<ReviewStarter>(async () => ({ reviewed: true, findings: [], summary: "reviewed" }));

/** T001 has a clean review behind it; T002 owns an outcome of the given priority and is not the last slice. */
async function feature(options: { priority: "must" | "should"; check?: boolean }) {
  setup = await productWorkspace({ critic: true });
  const state = await setup.workspace.state();
  const updated = await updateProductBrief(state, {
    brief: {
      ...setup.brief,
      outcomes: [
        ...setup.brief.outcomes,
        {
          id: "O002",
          kind: "quality",
          priority: options.priority,
          reviewRequired: true,
          statement: "The result reads as a finished answer",
        },
      ],
      checks: [
        ...setup.brief.checks,
        {
          id: "C002",
          command: [process.execPath, "--test", "test/value.test.mjs"],
          outcomes: ["O002"],
          files: ["src/value.mjs", "test/value.test.mjs"],
          environment: "node",
        },
      ],
      slices: [
        ...setup.brief.slices,
        {
          id: "T002",
          goal: "Make the answer read well",
          outcomes: ["O002"],
          scope: { allowed: ["src/value.mjs"] },
          checks: options.check ? ["C002"] : [],
        },
        {
          id: "T003",
          goal: "Keep the answer stable",
          outcomes: ["O001"],
          scope: { allowed: ["src/value.mjs"] },
          checks: ["C001"],
        },
      ],
    },
    reason: "A middle slice with a required review",
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  expect(
    (
      await runProductCritic(await setup.workspace.state(), {
        task: "T001",
        operation: "configure",
        config,
      })
    ).ok,
  ).toBe(true);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const first = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host()),
  );
  expect(first.ok && first.value.critic?.reviewed, JSON.stringify(first)).toBe(true);
  expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  expect(
    (
      await runProductCritic(await setup.workspace.state(), {
        task: "T002",
        operation: "configure",
        config,
      })
    ).ok,
  ).toBe(true);
}

beforeEach(() => undefined);
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
});

async function ownedBy(task: string) {
  const record = await readProductRecord(await setup.workspace.state(), {});
  if (!record.ok) throw new Error(record.error.message);
  const done = await runProductDone(await setup.workspace.state(), { task });
  if (!done.ok) throw new Error(done.error.message);
  const after = await readProductRecord(await setup.workspace.state(), {});
  if (!after.ok) throw new Error(after.error.message);
  return { record: after.value, subject: done.value.subjectDigest };
}

it("does not skip the review of a middle slice that owes a required review, and closes it after one", async () => {
  await feature({ priority: "must", check: true });
  const { record, subject } = await ownedBy("T002");
  expect(reviewOwed(record, "T002", subject)).toBe(true);
  expect(skippableReview(record, "T002", subject)).toBe(false);
  const spy = starter();
  const done = await runProductDoneReviewed(await setup.workspace.state(), { task: "T002" }, spy);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
  // A real review that satisfies the outcome then lets the slice close.
  const reviewed = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T002" },
    inlineReview(host()),
  );
  expect(reviewed.ok && reviewed.value.critic?.reviewed, JSON.stringify(reviewed)).toBe(true);
  const closed = await runProductDoneReviewed(await setup.workspace.state(), { task: "T002" });
  expect(closed.ok && closed.value.closed, JSON.stringify(closed)).toBe(true);
});

it("launches the review of a required outcome even when the slice has no check to run", async () => {
  await feature({ priority: "must" });
  const spy = starter();
  const done = await runProductDoneReviewed(await setup.workspace.state(), { task: "T002" }, spy);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.executions).toEqual([]);
  expect(done.value.closed).not.toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
});

it("keeps skipping the middle-slice review when no mandatory outcome owes one", async () => {
  await feature({ priority: "should", check: true });
  const { record, subject } = await ownedBy("T002");
  expect(reviewOwed(record, "T002", subject)).toBe(false);
  expect(skippableReview(record, "T002", subject)).toBe(true);
  const spy = starter();
  const done = await runProductDoneReviewed(await setup.workspace.state(), { task: "T002" }, spy);
  expect(done.ok && done.value.critic?.reason).toContain("previous independent review");
  expect(spy).not.toHaveBeenCalled();
});

it("never starts a review for a slice with no owed review and nothing that ran", async () => {
  await feature({ priority: "should" });
  const spy = starter();
  const done = await runProductDoneReviewed(await setup.workspace.state(), { task: "T002" }, spy);
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});
