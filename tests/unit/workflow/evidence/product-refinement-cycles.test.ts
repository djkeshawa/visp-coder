import { describe, expect, it } from "vitest";
import {
  initialProductState,
  type ProductAssessment,
  productBriefSchema,
} from "../../../../src/workflow/product/model.js";
import { productRefinement } from "../../../../src/workflow/product/refinement.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-cycles",
  originalRequest: "Usable interaction",
  goal: "Usable interaction",
  outcomes: [{ id: "O001", kind: "experience", statement: "The control is usable" }],
});
function review(
  implementation: string,
  status: ProductAssessment["status"] = "failed",
  subject = implementation,
) {
  return {
    subjectDigest: subject,
    implementationDigest: implementation,
    contractDigest: "contract",
    createdAt: "2026-01-01",
    captures: [],
    assessments: [
      {
        outcome: "O001",
        status,
        summary: "The same mismatch",
        evidence: [],
        expectations: [],
        provenance: "agent-reported" as const,
      },
    ],
  };
}
function record(reviews: ReturnType<typeof review>[]): ProductRecord {
  return {
    brief,
    briefText: "",
    stateText: "",
    state: { ...initialProductState(brief, "2026-01-01"), reviews },
  };
}

describe("actual refinement cycles", () => {
  it("allows two corrections after the initial finding", () => {
    expect(productRefinement(record([review("a")]))).toMatchObject({
      used: 0,
      remaining: 2,
      exhausted: false,
    });
    expect(productRefinement(record([review("a"), review("b")]))).toMatchObject({
      used: 1,
      remaining: 1,
      exhausted: false,
    });
    expect(productRefinement(record([review("a"), review("b"), review("c")]))).toMatchObject({
      used: 2,
      remaining: 0,
      exhausted: true,
    });
  });
  it("does not spend correction cycles on unavailable reviews, retries or metadata revisions", () => {
    const reviews = [
      review("a", "unavailable"),
      review("a"),
      review("a"),
      review("a", "failed", "new-metadata"),
      review("b", "unavailable"),
    ];
    expect(productRefinement(record(reviews))).toMatchObject({ used: 0, exhausted: false });
    expect(productRefinement(record([...reviews, review("b", "satisfied")]))).toMatchObject({
      used: 1,
    });
  });
  it("keeps failures visible across review scope changes and does not count unrelated outcomes", () => {
    const unrelated = review("x");
    for (const assessment of unrelated.assessments) assessment.outcome = "O999";
    expect(productRefinement(record([review("a"), unrelated, review("b")]))).toMatchObject({
      used: 1,
    });
  });
  it("counts a changed implementation once even when its outcomes are reviewed separately", () => {
    const testBrief = productBriefSchema.parse({
      ...brief,
      outcomes: [...brief.outcomes, { ...brief.outcomes[0], id: "O002" }],
    });
    const initial = review("a");
    initial.assessments.push({
      ...initial.assessments[0],
      outcome: "O002",
    } as (typeof initial.assessments)[number]);
    const first = review("b");
    const second = review("b");
    for (const assessment of second.assessments) assessment.outcome = "O002";
    expect(productRefinement({ ...record([initial, first, second]), brief: testBrief }).used).toBe(
      1,
    );
    expect(
      productRefinement(record([review("a"), review("a", "satisfied"), review("b", "satisfied")]))
        .used,
    ).toBe(0);
  });
});
