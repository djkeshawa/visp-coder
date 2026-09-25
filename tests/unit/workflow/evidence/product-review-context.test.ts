import { expect, it } from "vitest";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import {
  preferredReviewCaptures,
  previousReviewAssessments,
  productReviewAgenda,
} from "../../../../src/workflow/product/review-context.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-context",
  originalRequest: "The whole product works",
  goal: "Product",
  outcomes: [
    { id: "O001", kind: "experience", statement: "Useful screen" },
    { id: "O002", kind: "functional", statement: "Useful export" },
  ],
  slices: [
    { id: "T001", goal: "Screen", outcomes: ["O001"], scope: { allowed: ["screen.js"] } },
    { id: "T002", goal: "Export", outcomes: ["O002"], scope: { allowed: ["export.js"] } },
  ],
});

it("retains bounded existing design direction and references without requiring new collection", () => {
  const designed = {
    ...record,
    brief: {
      ...brief,
      design: {
        description: "A quiet editorial screen",
        references: ["docs/reference.png"],
        refinementCycles: 0,
      },
    },
  };
  const agenda = productReviewAgenda(designed, brief.slices[0]);
  expect(agenda.design).toMatchObject({
    description: "A quiet editorial screen",
    references: ["docs/reference.png"],
  });
  expect(agenda.goal).toBe("Screen");
  expect(agenda.visualPrompts).toHaveLength(1);
  expect(agenda.visualPrompts[0]?.prompt).toContain("Useful screen");
  expect(agenda.visualPrompts[0]?.prompt).toContain(
    "desktop pixels do not establish mobile quality",
  );
  expect(agenda.design?.guidance).toContain("optional");
  const bounded = productReviewAgenda({
    ...designed,
    brief: {
      ...designed.brief,
      design: {
        ...designed.brief.design,
        description: "x".repeat(4000),
        references: Array.from({ length: 9 }, (_, index) => `reference-${index}`),
      },
    },
  });
  expect(bounded.design?.description).toHaveLength(2400);
  expect(bounded.design?.references).toHaveLength(6);
  expect(bounded.omitted).toMatchObject({ designDescriptionCharacters: 1600, designReferences: 3 });
  expect(productReviewAgenda(record, brief.slices[1]).visualPrompts).toEqual([]);
});
const record: ProductRecord = {
  brief,
  briefText: "",
  stateText: "",
  state: initialProductState(brief, "2026-01-01"),
};
it("carries relevant final findings into a reopened slice with honest freshness", () => {
  const assessments = [
    {
      outcome: "O001",
      status: "failed" as const,
      summary: "Bad screen",
      evidence: [],
      expectations: [],
      provenance: "agent-reported" as const,
    },
    {
      outcome: "O002",
      status: "failed" as const,
      summary: "Bad export",
      evidence: [],
      expectations: [],
      provenance: "agent-reported" as const,
    },
  ];
  const final = {
    subjectDigest: "current",
    contractDigest: productContractDigest(brief),
    createdAt: "2026-01-01",
    assessments,
    captures: [],
  };
  const test = {
    ...record,
    state: {
      ...record.state,
      reviews: [{ ...final, task: "T999" }, { ...final, subjectDigest: "old" }, final],
    },
  };
  expect(previousReviewAssessments(test, "current", brief.slices[0])).toMatchObject([
    { current: false, assessments: [{ outcome: "O001" }] },
    { current: false, assessments: [{ outcome: "O001" }] },
    { current: true, assessments: [{ outcome: "O001" }] },
  ]);
  expect(previousReviewAssessments(test, "current")[2]?.assessments).toHaveLength(2);
});
it("prioritizes the newest relevant complete capture run over later unrelated images", () => {
  const run = (
    task: string | undefined,
    createdAt: string,
    ids: string[],
    subjectDigest = "current",
  ) => ({ task, createdAt, subjectDigest, captures: ids.map((id) => ({ id })) });
  const test = {
    ...record,
    state: {
      ...record.state,
      captureRuns: [
        null,
        {},
        run("T001", "2026-01-01", ["before-old", "after-old"]),
        run(undefined, "2026-01-02", ["before", "during", "after"]),
        run("T002", "2026-01-03", ["unrelated"]),
        run("T999", "2026-01-04", ["removed"]),
        run("T001", "2026-01-05", ["stale"], "old"),
      ],
    },
  };
  expect(preferredReviewCaptures(test, "current", brief.slices[0])).toEqual([
    "before",
    "during",
    "after",
  ]);
  expect(preferredReviewCaptures(record, "current")).toEqual([]);
});
