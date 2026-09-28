import { expect, it } from "vitest";
import { skippableReview } from "../../../../src/workflow/product/done-review.js";
import { reviewerVerifiedRepair } from "../../../../src/workflow/product/feedback.js";
import {
  CRITIC_INSTRUCTIONS,
  SOURCE_ADVICE_INSTRUCTIONS,
  UNDERSTANDING_CRITIC_INSTRUCTIONS,
} from "../../../../src/workflow/product/review-instructions.js";
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

it("sweeps stated rules and ordinary variants before spending findings on unstated limits", () => {
  expect(CRITIC_INSTRUCTIONS).toContain("every stated rule one by one");
  expect(CRITIC_INSTRUCTIONS).toContain("concrete input");
  expect(CRITIC_INSTRUCTIONS).toContain("whitespace-only lines");
  expect(CRITIC_INSTRUCTIONS).toContain("empty cells inside ranges");
  expect(CRITIC_INSTRUCTIONS).toContain("sign and zero formatting");
  expect(CRITIC_INSTRUCTIONS).toContain("required: false");
  expect(CRITIC_INSTRUCTIONS).toContain("recursion depth");
  expect(CRITIC_INSTRUCTIONS).toContain("Do not fail an outcome solely for advisory findings");
});

it("asks the reviewer to check that readable information is real, labeled text", () => {
  expect(CRITIC_INSTRUCTIONS).toContain("appears as real text with a word label");
  expect(CRITIC_INSTRUCTIONS).toContain("not only as canvas pixels or icons");
  expect(CRITIC_INSTRUCTIONS).toContain("normal (not required) finding, after functional defects");
  expect(CRITIC_INSTRUCTIONS).toContain(
    "only when the request states the information must be shown",
  );
  // Product-review only: the shared basics also feed understanding and source-advice reviews.
  expect(UNDERSTANDING_CRITIC_INSTRUCTIONS).not.toContain("word label");
  expect(SOURCE_ADVICE_INSTRUCTIONS).not.toContain("word label");
});

it.each([false, true])("only required findings prevent skipping middle reviews: %s", (required) => {
  const current = record("satisfied", { T001: "closed", T002: "in-progress", T003: "pending" });
  const review = current.state.reviews[0];
  if (!review) throw new Error("Missing review");
  review.feedback = {
    phase: "product",
    summary: "Review",
    dimensions: [],
    resolutions: [],
    findings: [
      {
        dimension: "functional",
        problem: "Extreme input",
        nextCheck: "Try a huge number",
        outcomes: [],
        required,
        evidence: [],
      },
    ],
  };
  expect(skippableReview(current, "T002")).toBe(!required);
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
