import { expect, it } from "vitest";
import type { ProductEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import {
  feedbackTemplate,
  outstandingFeedback,
  productFeedbackGaps,
  productFeedbackPlan,
  validateProductFeedback,
} from "../../../../src/workflow/product/feedback.js";
import type { ProductFeedback } from "../../../../src/workflow/product/feedback-model.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { currentProbeResponses } from "../../../../src/workflow/product/probe-feedback.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-game",
  goal: "Fun game",
  originalRequest: "Fun game",
  outcomes: [
    { id: "O001", kind: "functional", statement: "Launch and retry" },
    { id: "O002", kind: "experience", statement: "Comfortable mobile play" },
  ],
  slices: [
    { id: "T001", goal: "Play", outcomes: ["O001", "O002"], scope: { allowed: ["game.js"] } },
  ],
});
const record = { brief, briefText: "", stateText: "", state: initialProductState(brief, "now") };
const catalogue: ProductEvidenceCatalogue = {
  entries: [
    {
      id: "C1",
      kind: "execution",
      status: "available",
      outcomes: ["O001"],
      summary: "Real helper execution",
    },
    {
      id: "SYNTAX",
      kind: "execution",
      status: "available",
      outcomes: ["O001"],
      summary: "node --check game.js",
      supportsBehavior: false,
    },
    { id: "CODE-owner", kind: "source", status: "available", outcomes: [], summary: "Input owner" },
    {
      id: "IMG",
      kind: "image",
      status: "available",
      outcomes: ["O002"],
      summary: "Mobile capture",
    },
    {
      id: "NAV",
      kind: "operation",
      status: "available",
      outcomes: [],
      summary: "navigate",
      measurement: { json: '{"matched":true}', truncated: false },
      supportsBehavior: false,
    },
    {
      id: "OBS",
      kind: "operation",
      status: "available",
      outcomes: [],
      summary: "observe",
      measurement: { json: '{"matched":true}', truncated: false },
      supportsBehavior: true,
    },
    {
      id: "TRUNC",
      kind: "operation",
      status: "available",
      outcomes: [],
      summary: "observe",
      measurement: { json: "{}", truncated: true },
    },
    { id: "STALE", kind: "image", status: "stale", outcomes: [], summary: "Old pixels" },
    { id: "GAP", kind: "image", status: "unavailable", outcomes: [], summary: "Missing pixels" },
  ],
  aliases: new Map([["check", "C1"]]),
  sources: [],
  sourceClaims: [],
};
function response(
  kind: NonNullable<ProductFeedback["probes"]>[number]["kind"] = "independent-result",
) {
  return {
    kind,
    expected: "Pulling down-left sends the bird up-right",
    basis: "Agent-proposed restoring-force convention, independent of the preview",
    exercise: "Pull down-left and inspect initial displacement",
    observed: "The bird moved up-right",
    status: "satisfied" as const,
    evidence: ["check"],
  };
}
function feedback(probes: NonNullable<ProductFeedback["probes"]>): ProductFeedback {
  return { ...feedbackTemplate(), probes };
}
function review(fb: ProductFeedback, subjectDigest = "current", task: string | undefined = "T001") {
  return {
    policyVersion: 5 as const,
    subjectDigest,
    contractDigest: productContractDigest(
      brief,
      brief.slices.find((s) => s.id === task),
    ),
    task,
    createdAt: "now",
    assessments: [],
    captures: [],
    feedback: fb,
  };
}
it("keeps unassessed probes visible without adding a second mandatory review form", () => {
  const state = { ...record, state: { ...record.state, reviews: [review(feedbackTemplate())] } };
  expect(productFeedbackGaps(state, "current")).toEqual([]);
  expect(productFeedbackPlan(state, "current").observationPlan.probes).toHaveLength(3);
});

it.each([
  [[], "unclear"],
  [["CODE-owner"], "unclear"],
  [["NAV"], "unclear"],
  [["TRUNC"], "unclear"],
  [["SYNTAX"], "unclear"],
  [["check"], "satisfied"],
  [["OBS"], "satisfied"],
])("requires actual execution, allowing indirect test helpers: %j", (evidence, status) => {
  const result = validateProductFeedback(
    feedback([{ ...response(), evidence: evidence as string[] }]),
    record,
    catalogue,
    { context: "current" },
  );
  expect(result.ok && result.value?.probes?.[0]?.status).toBe(status);
});
it("requires images for usability, preserves missing evidence as a gap, and rejects stale or fabricated citations", () => {
  for (const [evidence, status] of [
    [["C1"], "unclear"],
    [["OBS", "IMG"], "satisfied"],
  ] as const) {
    const result = validateProductFeedback(
      feedback([{ ...response("rendered-usability"), evidence: [...evidence] }]),
      record,
      catalogue,
      { context: "fresh" },
    );
    expect(result.ok && result.value?.probes?.[0]?.status).toBe(status);
  }
  for (const id of ["STALE", "invented"])
    expect(
      validateProductFeedback(feedback([{ ...response(), evidence: [id] }]), record, catalogue, {
        context: "current",
      }).ok,
    ).toBe(false);
  const gap = validateProductFeedback(
    feedback([{ ...response("rendered-usability"), status: "unavailable", evidence: ["GAP"] }]),
    record,
    catalogue,
    { context: "unavailable" },
  );
  expect(gap.ok && gap.value?.probes?.[0]?.status).toBe("unavailable");
});
it("permits justified non-applicability only for repeat/recovery", () => {
  for (const kind of ["independent-result", "repeat-and-recover", "rendered-usability"] as const) {
    const r = validateProductFeedback(
      feedback([{ ...response(kind), status: "not-applicable", evidence: ["CODE-owner"] }]),
      record,
      catalogue,
      { context: "current" },
    );
    expect(r.ok && r.value?.probes?.[0]?.status).toBe(
      kind === "repeat-and-recover" ? "not-applicable" : "unclear",
    );
  }
  const duplicate = feedback([response(), response()]);
  expect(validateProductFeedback(duplicate, record, catalogue, { context: "current" }).ok).toBe(
    false,
  );
});
it("keeps partial repairs and invalidates answers after source/contract changes", () => {
  const state = {
    ...record,
    state: {
      ...record.state,
      reviews: [
        review(feedback([response()])),
        review(feedback([response("repeat-and-recover")])),
        review(feedback([response("rendered-usability")]), "old"),
      ],
    },
  };
  expect(currentProbeResponses(state, "current").size).toBe(2);
  expect(currentProbeResponses(state, "new").size).toBe(0);
  expect(productFeedbackPlan(state, "current").nextProbe?.kind).toBe("rendered-usability");
  expect(
    currentProbeResponses(
      {
        ...state,
        brief: {
          ...brief,
          slices: brief.slices.map((slice) => ({ ...slice, approach: "Different lifecycle" })),
          checks: [
            {
              id: "C9",
              command: ["node", "test.js"],
              outcomes: ["O001"],
              files: [],
              environment: "node",
            },
          ],
        },
      },
      "current",
    ).size,
  ).toBe(0);
  const invalid = {
    ...state,
    state: { ...state.state, reviews: [review(feedback([response()]), "current", "T999")] },
  };
  expect(currentProbeResponses(invalid, "current").size).toBe(0);
});
it("routes a mismatched probe into persistent findings, research and code tracing", () => {
  const r = {
    ...record,
    state: {
      ...record.state,
      reviews: [
        review(feedback([{ ...response(), status: "failed", observed: "Bird moved down-right" }])),
      ],
    },
  };
  const plan = productFeedbackPlan(r, "current", brief.slices[0]);
  expect(outstandingFeedback(r)[0]?.problem).toContain("down-right");
  expect(plan.research?.question).toContain("down-right");
  expect(plan.trace.question).toContain("down-right");
  expect(plan.nextCheck).toContain("Pull down-left");
  const unavailable = validateProductFeedback(feedback([response()]), record, catalogue, {
    context: "unavailable",
  });
  expect(unavailable.ok && unavailable.value?.probes?.[0]?.status).toBe("unavailable");
});

it("does not treat submission retries as correction cycles or borrow answers across product scopes", async () => {
  const { productRefinement } = await import("../../../../src/workflow/product/refinement.js");
  const failed = feedback([{ ...response(), status: "failed", observed: "Wrong direction" }]);
  const r = {
    ...record,
    state: {
      ...record.state,
      reviews: [
        { ...review(failed), implementationDigest: "code-a" },
        { ...review(failed), implementationDigest: "code-a" },
        { ...review(failed), implementationDigest: "code-b" },
      ],
    },
  };
  expect(productRefinement(r).used).toBe(1);
  r.state.reviews.push({ ...review(failed), implementationDigest: "code-c" });
  expect(productRefinement(r).exhausted).toBe(true);
  const firstSlice = brief.slices[0];
  if (!firstSlice) throw new Error("Missing slice");
  const multi = {
    ...record,
    brief: {
      ...brief,
      slices: [...brief.slices, { ...firstSlice, id: "T002", outcomes: ["O002"], goal: "Screen" }],
    },
  };
  const global = {
    ...review(feedback([response()]), "current", undefined),
    contractDigest: productContractDigest(multi.brief),
  };
  expect(
    currentProbeResponses(
      { ...multi, state: { ...multi.state, reviews: [global] } },
      "current",
      multi.brief.slices[1],
    ).size,
  ).toBe(0);
  const owner = multi.brief.slices[0];
  if (!owner) throw new Error("Missing owner");
  const scoped = {
    ...review(feedback([response()])),
    contractDigest: productContractDigest(multi.brief, owner),
  };
  expect(
    currentProbeResponses({ ...multi, state: { ...multi.state, reviews: [scoped] } }, "current")
      .size,
  ).toBe(0);
});
