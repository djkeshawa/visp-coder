import { expect, it } from "vitest";
import { productReviewChallenges } from "../../../../src/workflow/product/coverage.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { productRefinement } from "../../../../src/workflow/product/refinement.js";
import { productReviewRecurrence } from "../../../../src/workflow/product/review-recurrence.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";

type Review = ProductRecord["state"]["reviews"][number];
const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-recurrence",
  originalRequest: "A useful product",
  goal: "A useful product",
  outcomes: [
    { id: "O001", kind: "experience", priority: "must", statement: "Readable composition" },
    { id: "O002", kind: "functional", priority: "must", statement: "Export works" },
    { id: "O003", kind: "quality", priority: "could", statement: "Optional polish" },
    { id: "O004", kind: "quality", priority: "must", statement: "Fast" },
    { id: "O005", kind: "quality", priority: "must", statement: "Useful" },
  ],
  examples: [
    {
      id: "E001",
      title: "Boot",
      when: "Open",
      expected: ["The board appears"],
      outcomes: ["O001"],
    },
  ],
  slices: [
    { id: "T001", goal: "Screen", outcomes: ["O001"], scope: { allowed: ["screen.js"] } },
    { id: "T002", goal: "Export", outcomes: ["O002"], scope: { allowed: ["export.js"] } },
    { id: "T003", goal: "Polish", outcomes: ["O003"], scope: { allowed: ["polish.js"] } },
  ],
});
const record = (reviews: Review[] = []): ProductRecord => ({
  brief,
  briefText: "",
  stateText: "",
  state: { ...initialProductState(brief, "2026-01-01"), reviews },
});
const challenge = productReviewChallenges(record())[0]?.id ?? "missing";
function review(
  assessments: Array<[string, "failed" | "satisfied" | "unclear" | "unavailable"]> = [],
  coverage: Review["coverage"] = [],
  extra: Partial<Review> = {},
): Review {
  return {
    policyVersion: 3,
    subjectDigest: "subject",
    implementationDigest: "implementation",
    contractDigest: "contract",
    createdAt: "2026-01-01",
    captures: [],
    assessments: assessments.map(([outcome, status]) => ({
      outcome,
      status,
      summary: "Observed mismatch",
      evidence: [],
      expectations: [],
      provenance: "agent-reported",
    })),
    coverage,
    ...extra,
  };
}
const failedCase = (reason = "Board missing") => ({
  id: challenge,
  status: "failed" as const,
  reason,
  evidence: [],
});

it("counts repeated challenge failures independently of summaries, references and metadata", () => {
  const input = record([
    review([["O001", "failed"]], [failedCase()]),
    review(
      [["O001", "failed"]],
      [{ ...failedCase("Same failure, clearer explanation"), evidence: ["different-reference"] }],
      { subjectDigest: "new-metadata-subject", contractDigest: "new-metadata-contract" },
    ),
  ]);
  const before = JSON.stringify(input),
    budget = productRefinement(input);
  const result = productReviewRecurrence(input, "implementation");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: challenge, attempts: 2 });
  expect(result[0]?.reason).toContain("clearer explanation");
  expect(result[0]?.recovery).toContain("configured model");
  expect(JSON.stringify(input)).toBe(before);
  expect(productRefinement(input)).toEqual(budget);
});

it("counts visual outcome failures even when unrelated examples exist without duplicating an explained parent", () => {
  expect(
    productReviewRecurrence(
      record([review([["O001", "failed"]]), review([["O001", "failed"]])]),
      "implementation",
    ),
  ).toMatchObject([{ id: "O001", attempts: 2 }]);
  expect(
    productReviewRecurrence(
      record([
        review([["O001", "failed"]], [failedCase()]),
        review([["O001", "failed"]], [failedCase()]),
      ]),
      "implementation",
    ),
  ).toMatchObject([{ id: challenge, attempts: 2 }]);
});

it("ignores unclear, unavailable and unavailable-reviewer retries without erasing unresolved cases", () => {
  const input = record([
    review([["O002", "failed"]], [failedCase()]),
    review([["O002", "failed"]], [failedCase()]),
    review([["O002", "unclear"]], [{ ...failedCase(), status: "unclear" }]),
    review([["O002", "unavailable"]], [{ ...failedCase(), status: "unavailable" }]),
    review([["O002", "failed"]], [failedCase()], { reviewer: { context: "unavailable" } }),
    review(),
  ]);
  expect(
    productReviewRecurrence(input, "implementation").map(({ id, attempts }) => ({ id, attempts })),
  ).toEqual(
    expect.arrayContaining([
      { id: challenge, attempts: 2 },
      { id: "O002", attempts: 2 },
    ]),
  );
});

it("clears only satisfied cases and restarts counts after an implementation change, including a revert", () => {
  const failures = [
    review([["O002", "failed"]], [failedCase()]),
    review([["O002", "failed"]], [failedCase()]),
  ];
  const partialPass = record([...failures, review([], [{ ...failedCase(), status: "satisfied" }])]);
  expect(productReviewRecurrence(partialPass, "implementation")).toMatchObject([
    { id: "O002", attempts: 2 },
  ]);
  partialPass.state.reviews.push(review([["O002", "satisfied"]]));
  expect(productReviewRecurrence(partialPass, "implementation")).toEqual([]);
  expect(productReviewRecurrence(record(failures), "changed-implementation")).toEqual([]);
  const reverted = record([
    ...failures,
    review([], [], { implementationDigest: "changed-implementation" }),
    review([["O002", "failed"]], [failedCase()]),
  ]);
  expect(productReviewRecurrence(reverted, "implementation")).toEqual([]);
});

it("bounds recurring feedback to three required cases and respects slice ownership", () => {
  const failures: Array<[string, "failed"]> = [
    ["O001", "failed"],
    ["O002", "failed"],
    ["O003", "failed"],
    ["O004", "failed"],
    ["O005", "failed"],
  ];
  const input = record([review(failures), review(failures)]);
  expect(productReviewRecurrence(input, "implementation")).toHaveLength(3);
  expect(
    productReviewRecurrence(input, "implementation").some((entry) => entry.id === "O003"),
  ).toBe(false);
  expect(productReviewRecurrence(input, "implementation", brief.slices[0])).toMatchObject([
    { id: "O001", attempts: 2 },
  ]);
  const wrongOwner = record([
    review([["O001", "failed"]], [failedCase()], { task: "T002" }),
    review([["O001", "failed"]], [failedCase()], { task: "T002" }),
    review(failures, [], { task: "T999" }),
  ]);
  expect(productReviewRecurrence(wrongOwner, "implementation")).toEqual([]);
});
