import { expect, it } from "vitest";
import { skippableReview } from "../../../../src/workflow/product/done-review.js";
import { reviewerVerifiedRepair } from "../../../../src/workflow/product/feedback.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";

function record(
  status: "satisfied" | "failed",
  slices: Record<string, "closed" | "in-progress" | "pending">,
): ProductRecord {
  return {
    brief: { slices: Object.keys(slices).map((id) => ({ id })), outcomes: [] },
    state: {
      slices: Object.fromEntries(
        Object.entries(slices).map(([id, value]) => [id, { status: value }]),
      ),
      reviews: [
        {
          reviewer: { model: "gpt-5.6-sol", context: "fresh" },
          assessments: [{ outcome: "O001", status }],
        },
      ],
    },
  } as unknown as ProductRecord;
}

// Weak-worker runs: a review after a clean one rarely found anything, at 1–2 min each.
it("skips a middle slice's review after a clean one, never the slice completing the feature", () => {
  const open = { T001: "closed", T002: "in-progress", T003: "pending" } as const;
  expect(skippableReview(record("satisfied", open), "T002")).toBe(true);
  expect(skippableReview(record("failed", open), "T002")).toBe(false);
  const last = { T001: "closed", T002: "in-progress" } as const;
  expect(skippableReview(record("satisfied", last), "T002")).toBe(false);
});

// Workers repair before anyone records a failing reproduction.
it("lets only a fresh reviewer close a finding with current passing executions of its outcomes", () => {
  const finding = { outcomes: ["O001"] } as unknown as Parameters<typeof reviewerVerifiedRepair>[0];
  const catalogue = {
    entries: [
      { id: "EX-1", kind: "execution", status: "available", outcomes: ["O001"] },
      { id: "EX-2", kind: "execution", status: "failed", outcomes: ["O001"] },
      { id: "SRC-1", kind: "source", status: "available", outcomes: ["O001"] },
    ],
    aliases: new Map<string, string>(),
  } as unknown as Parameters<typeof reviewerVerifiedRepair>[2];
  const fresh = { context: "fresh" } as Parameters<typeof reviewerVerifiedRepair>[3];
  const current = { context: "current" } as Parameters<typeof reviewerVerifiedRepair>[3];
  expect(reviewerVerifiedRepair(finding, ["EX-1"], catalogue, fresh)).toBe(true);
  expect(reviewerVerifiedRepair(finding, ["EX-1"], catalogue, current)).toBe(false);
  expect(reviewerVerifiedRepair(finding, ["EX-2"], catalogue, fresh)).toBe(false);
  expect(reviewerVerifiedRepair(finding, ["SRC-1"], catalogue, fresh)).toBe(false);
});
