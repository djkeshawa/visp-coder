import { expect, it } from "vitest";
import { skippableReview } from "../../../../src/workflow/product/done-review.js";
import { reviewerVerifiedRepair } from "../../../../src/workflow/product/feedback.js";
import {
  CRITIC_INSTRUCTIONS,
  SOURCE_ADVICE_INSTRUCTIONS,
  UNDERSTANDING_CRITIC_INSTRUCTIONS,
} from "../../../../src/workflow/product/review-instructions.js";
import { repairObjective } from "../../../../src/workflow/product/status-next.js";
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

// Reviewer findings that asked for new rejection broke the request's own normal call in two
// benchmark runs; findings need a named source sentence and a keep-succeeding recheck.
it("requires a stated rule and a keep-succeeding nextCheck for findings that add rejection", () => {
  for (const text of [
    CRITIC_INSTRUCTIONS,
    SOURCE_ADVICE_INSTRUCTIONS,
    UNDERSTANDING_CRITIC_INSTRUCTIONS,
  ]) {
    expect(text).toContain("asks for NEW rejection of inputs");
    expect(text).toContain("or a recorded decision (M#)");
    expect(text).toContain("name that sentence in the finding");
    expect(text).toContain("A natural variant of a stated rejection rule counts as stated");
    expect(text).toContain("crash or 5xx");
    expect(text).toContain("path traversal out of the stated directory");
    expect(text).toContain("A rule covers an operation only if");
    expect(text).toContain("does not cover an operation whose normal call has none");
    expect(text).toContain("at most advisory");
    expect(text).toContain("the normal call wins");
    expect(text).toContain(
      "Its nextCheck also confirms that the request's normal call, as described, still succeeds.",
    );
  }
});

const WORKER_LINE =
  "If a fix rejects inputs, first add a test that the request's normal call still succeeds and keep it passing; reject only what the finding names. If a finding would break that call, do not apply it; say so in your done note";

it("tells the worker to keep the request's normal call passing, on repair routes only", () => {
  const record = (cycles?: number) =>
    ({
      brief: {
        outcomes: [],
        ...(cycles === undefined ? {} : { design: { refinementCycles: cycles } }),
      },
      state: { reviews: [] },
    }) as unknown as ProductRecord;
  const slice = { id: "T001", outcomes: [] } as unknown as Parameters<typeof repairObjective>[1];
  expect(repairObjective(record(), slice, false, true)).toContain(WORKER_LINE);
  expect(repairObjective(record(), slice, false, false)).toContain(WORKER_LINE);
  // No trailing period: the stop hook appends its own text after the objective.
  expect(repairObjective(record(), slice, false, true).endsWith("done note")).toBe(true);
  expect(repairObjective(record(0), slice, false, false)).not.toContain("normal call");
  expect(repairObjective(record(), slice, true, false)).not.toContain("normal call");
});
