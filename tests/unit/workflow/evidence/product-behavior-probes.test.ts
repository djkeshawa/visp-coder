import { expect, it } from "vitest";
import { productBehaviorProbes } from "../../../../src/workflow/product/behavior-probes.js";
import { productFeedbackPlan } from "../../../../src/workflow/product/feedback.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import {
  summarizeLayout,
  summarizeObservation,
} from "../../../../src/workflow/product/observation-summary.js";
import {
  productReviewAgenda,
  reviewInteractionEvidence,
} from "../../../../src/workflow/product/review-context.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-probes",
  originalRequest: "A playable game and useful export",
  goal: "Game",
  outcomes: [
    { id: "O001", kind: "functional", statement: "Aim, release, reset and play again" },
    { id: "O002", kind: "experience", statement: "Readable mobile game" },
    { id: "O003", kind: "quality", statement: "Export has bounded memory" },
  ],
  examples: [
    {
      id: "E001",
      title: "Launch",
      given: ["Ready"],
      when: "Pull down-left and release",
      expected: ["Bird travels up-right"],
      outcomes: ["O001"],
    },
  ],
  slices: [
    { id: "T001", goal: "Game", outcomes: ["O001", "O002"], scope: { allowed: ["game.js"] } },
    { id: "T002", goal: "Export", outcomes: ["O003"], scope: { allowed: ["export.js"] } },
  ],
});
const record = {
  brief,
  state: initialProductState(brief, "2026-09-09"),
  briefText: "",
  stateText: "",
};

it("derives bounded probes from retained promises without mutating the brief or expanding another slice", () => {
  const before = JSON.stringify(record);
  const plan = productBehaviorProbes(record, brief.slices[0]);
  expect(plan.probes.map((probe) => probe.kind)).toEqual([
    "independent-result",
    "repeat-and-recover",
    "rendered-usability",
  ]);
  expect(plan.probes[0]).toMatchObject({
    example: "E001",
    expected: ["Bird travels up-right"],
    outcomes: ["O001"],
  });
  expect(productReviewAgenda(record, brief.slices[0]).behavioralProbes).toEqual(plan);
  expect(productFeedbackPlan(record, "subject", brief.slices[0]).nextProbe).toEqual(plan.probes[0]);
  expect(
    productFeedbackPlan(record, "subject", brief.slices[0]).observationPlan.probes.map(
      (entry) => entry.kind,
    ),
  ).toEqual(plan.probes.map((probe) => probe.kind));
  expect(productFeedbackPlan(record, "subject", brief.slices[0]).observationPlan.session).toContain(
    "same browser session",
  );
  expect(productBehaviorProbes(record, brief.slices[1]).probes).toEqual([]);
  expect(JSON.stringify(record)).toBe(before);
  const noExamples = { ...record, brief: { ...brief, examples: [] } };
  expect(productBehaviorProbes(noExamples).probes[0]?.expected).toEqual([
    "Aim, release, reset and play again",
  ]);
});

it("reports the exact observed condition rather than promoting a flight flag to physics coverage", () => {
  const expected = { selector: "#canvas", attribute: { name: "data-state", value: "flight" } };
  const actual = { attribute: "flight", count: 1 };
  const entry = {
    id: "OP1",
    measurement: { json: JSON.stringify({ expected, actual, matched: true }), truncated: false },
  };
  expect(summarizeObservation(entry)).toMatchObject({ status: "matched", expected, actual });
  expect(summarizeObservation(entry).limitation).toContain("does not establish correct motion");
  expect(summarizeObservation({ id: "missing" }).status).toBe("unavailable");
  expect(
    summarizeObservation({ ...entry, measurement: { json: "{", truncated: false } }).status,
  ).toBe("unavailable");
  expect(
    summarizeObservation({ ...entry, measurement: { json: "{}", truncated: false } }).status,
  ).toBe("unavailable");
  expect(
    summarizeObservation({ ...entry, measurement: { ...entry.measurement, truncated: true } })
      .status,
  ).toBe("unavailable");
});

const layout = {
  kind: "rendered-layout",
  captureId: "CAP",
  result: {
    version: 1,
    viewport: { width: 390, height: 844 },
    canvases: [
      {
        element: "canvas#game",
        intrinsic: { width: 960, height: 540 },
        content: { width: 350, height: 300 },
        scaleRatio: (300 * 960) / (350 * 540),
      },
    ],
    clipped: [{ element: "p#instructions", visibleFraction: 0.4 }],
    omittedCanvases: 0,
    uninspectedElements: 0,
  },
};

it("reports runner geometry as contextual concerns and rejects incomplete or unlinked measurements", () => {
  const entry = {
    id: "layout-op",
    measurement: { json: JSON.stringify(layout), truncated: false },
  };
  const summary = summarizeLayout(entry, new Set(["CAP"]));
  expect(summary[0]?.concerns).toHaveLength(2);
  expect(summary[0]?.concerns[0]).toContain("1.524");
  expect(summary[0]?.limitation).toContain("not automatically bugs");
  expect(summarizeLayout(entry, new Set())).toEqual([]);
  expect(summarizeLayout({ id: "missing" }, new Set(["CAP"]))).toEqual([]);
  expect(
    summarizeLayout(
      { ...entry, measurement: { ...entry.measurement, truncated: true } },
      new Set(["CAP"]),
    ),
  ).toEqual([]);
  expect(
    summarizeLayout({ ...entry, measurement: { json: "{", truncated: false } }, new Set(["CAP"])),
  ).toEqual([]);
  const ordinary = {
    ...layout,
    result: {
      ...layout.result,
      canvases: [{ ...layout.result.canvases[0], scaleRatio: 1 }],
      clipped: [],
    },
  };
  expect(
    summarizeLayout(
      { ...entry, measurement: { json: JSON.stringify(ordinary), truncated: false } },
      new Set(["CAP"]),
    )[0]?.concerns,
  ).toEqual([]);
});

it("keeps terminal and repeated-use evidence distinct from a newer shallow launch run", () => {
  const run = (id: string, attribute: string, subjectDigest = "current", task = "T001") => ({
    id,
    version: 2,
    provenance: "runner-executed",
    subjectDigest,
    task,
    contractDigest: productContractDigest(
      brief,
      brief.slices.find((entry) => entry.id === task),
    ),
    status: "completed",
    captures: [],
    operations: [
      {
        id: `${id}-observation`,
        kind: "observe",
        measurement: {
          json: JSON.stringify({
            expected: { selector: "#canvas", attribute: { name: "data-state", value: attribute } },
            actual: { attribute },
            matched: true,
          }),
          truncated: false,
        },
      },
    ],
  });
  const test = {
    ...record,
    state: {
      ...record.state,
      captureRuns: [
        run("settled", "result"),
        run("launch", "flight"),
        run("stale", "ready", "old"),
        run("unrelated", "exported", "current", "T002"),
      ],
    },
  };
  const result = reviewInteractionEvidence(test, "current", brief.slices[0]);
  expect(result.runs.map((entry) => entry.runId)).toEqual(["settled", "launch"]);
  expect(result.runs[0]?.observations[0]).toMatchObject({
    status: "matched",
    expected: { attribute: { value: "result" } },
  });
  expect(result.runs[0]?.layoutAvailability).toContain("No complete runner");
});

it("prioritizes recurring browser behavior failures over an unrelated initial research question", () => {
  const run = (id: string, kind = "behavior", subjectDigest = "current", task = "T001") => ({
    id,
    version: 2,
    provenance: "runner-executed",
    subjectDigest,
    task,
    contractDigest: productContractDigest(
      brief,
      brief.slices.find((slice) => slice.id === task),
    ),
    status: "timed-out",
    captures: [],
    operations: [],
    failure: { kind, message: "#target: expected direct hit was not observed" },
  });
  const test = {
    ...record,
    brief: { ...brief, uncertainties: ["Which decorative palette should be used?"] },
    state: {
      ...record.state,
      captureRuns: [
        null,
        run("old", "behavior", "stale"),
        run("other", "behavior", "current", "T002"),
        run("first"),
        run("second"),
      ],
    },
  };
  const plan = productFeedbackPlan(test, "current", brief.slices[0]);
  expect(plan.research?.question).toContain("different hypothesis");
  expect(plan.research?.question).toContain("#target");
  expect(plan.trace.question).toContain("input convention");
  const unavailable = {
    ...test,
    state: { ...record.state, captureRuns: [run("environment", "environment")] },
  };
  expect(productFeedbackPlan(unavailable, "current", brief.slices[0]).research?.question).toBe(
    test.brief.uncertainties[0],
  );
});
