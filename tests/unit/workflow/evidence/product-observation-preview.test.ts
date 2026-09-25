import { expect, it } from "vitest";
import { configSchema, defaultConfig } from "../../../../src/config/schema.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { observationSequence } from "../../../../src/workflow/product/observation-preview.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

it("keeps observation review opt-in and selects distinct recorded input states", () => {
  expect(defaultConfig().workflow.reviewMode).toBe("current");
  expect(
    configSchema.parse({ workflow: { reviewMode: "observation-preview" } }).workflow.reviewMode,
  ).toBe("observation-preview");
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-preview",
    originalRequest: "A browser game",
    goal: "Game",
    outcomes: [{ id: "O001", kind: "experience", statement: "Usable interaction" }],
    slices: [
      {
        id: "T001",
        goal: "First interaction",
        outcomes: ["O001"],
        scope: { allowed: ["index.html"] },
      },
    ],
  });
  const captures = [
    ["Navigate /"],
    ["Navigate /", "Begin pointer drag"],
    ["Navigate /", "Begin pointer drag", "Finish pointer drag"],
    ["Navigate /", "Observe result"],
  ].map((steps, i) => ({
    id: `CAP-${i}`,
    path: `.visp/${i}.png`,
    sha256: String(i).repeat(64),
    subjectDigest: "current",
    route: "/",
    viewport: { width: 1280, height: 720 },
    steps,
    createdAt: "now",
    provenance: "runner-captured",
  }));
  const run = {
    id: "run",
    version: 2,
    provenance: "runner-executed",
    subjectDigest: "current",
    contractDigest: productContractDigest(brief, brief.slices[0]),
    task: "T001",
    status: "completed",
    captures,
    operations: [],
  };
  const record = {
    brief,
    briefText: "",
    stateText: "",
    state: { ...initialProductState(brief, "now"), captureRuns: [run, { ...run, id: "repeat" }] },
  };
  const sequence = observationSequence(record, "current", brief.slices[0]);
  expect(sequence.states.map((entry) => entry.label)).toEqual([
    "initial recorded state",
    "held drag",
    "after drag release",
    "final recorded state",
  ]);
  expect(sequence.omittedCaptureIds).toHaveLength(4);
  expect(observationSequence(record, "changed", brief.slices[0]).states).toEqual([]);
});

it("distinguishes later operations from an earlier release and retains recovery within the budget", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-preview",
    originalRequest: "Interactive browser tool",
    goal: "Tool",
    outcomes: [],
    slices: [],
  });
  const steps = [
    "Navigate /",
    "Begin pointer drag",
    "Finish pointer drag",
    "Move pointer to 200,200",
    "Observe result",
    "Observe summary",
    "Click Reset",
  ];
  const captures = steps.map((_step, index) => ({
    id: `CAP-${index}`,
    path: `.visp/${index}.png`,
    sha256: String(index).repeat(64),
    subjectDigest: "current",
    route: "/",
    steps: steps.slice(0, index + 1),
    viewport: { width: 1280, height: 720 },
    createdAt: "now",
    provenance: "runner-captured",
  }));
  const record = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "now"),
      captureRuns: [
        {
          id: "run",
          version: 2,
          provenance: "runner-executed",
          subjectDigest: "current",
          contractDigest: productContractDigest(brief),
          status: "completed",
          captures,
          operations: [],
        },
      ],
    },
  };
  const selected = observationSequence(record, "current");
  expect(selected.states).toHaveLength(6);
  expect(selected.states.find((state) => state.id === "CAP-3")?.label).toBe(
    "intermediate recorded state: Move pointer to 200,200",
  );
  expect(selected.states.at(-1)).toMatchObject({ id: "CAP-6", label: "final recorded state" });
  expect(selected.omittedCaptureIds).toEqual(["CAP-5"]);
});
