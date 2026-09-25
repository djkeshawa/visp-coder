import { expect, it } from "vitest";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import { needsBrowser } from "../../../../src/workflow/product/environment.js";
import {
  currentFailedJourneys,
  type ProductEvidenceCatalogue,
} from "../../../../src/workflow/product/evidence-references.js";
import {
  experimentRecoverySuggestions,
  experimentReviewContext,
  validateExperimentResolutions,
} from "../../../../src/workflow/product/experiments.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import {
  validateReviewSelection,
  validateSelectedImages,
} from "../../../../src/workflow/product/review-selection.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

const brief = productBriefSchema.parse({
  version: 2,
  feature: "001-boundary",
  originalRequest: "A useful browser interface",
  goal: "Useful interface",
  outcomes: [{ id: "O001", kind: "experience", statement: "Readable terminal state" }],
  slices: [
    {
      id: "T001",
      goal: "Complete interface",
      outcomes: ["O001"],
      scope: { allowed: ["index.html"] },
    },
  ],
});
const contractDigest = productContractDigest(brief, brief.slices[0]);
const image = {
  id: "pixels",
  subjectDigest: "subject",
  sha256: "a".repeat(64),
  path: ".visp/pixels.png",
  route: "/Play",
  viewport: { width: 390, height: 844 },
  steps: ["Win"],
  createdAt: "now",
  provenance: "runner-captured",
};
const failure = {
  id: "failure",
  version: 2,
  provenance: "runner-executed",
  subjectDigest: "subject",
  task: "T001",
  contractDigest,
  journeyKey: "journey-v2:old",
  status: "timed-out",
  failure: { kind: "behavior", message: "Wrong enabled-state wait" },
  captures: [image],
  operations: [],
};
const replacement = {
  ...failure,
  id: "replacement",
  journeyKey: "journey-v2:new",
  status: "completed",
  operations: [
    {
      id: "observation",
      kind: "observe",
      measurement: { json: '{"matched":true}', truncated: false },
    },
  ],
};
function record(): ProductRecord {
  return {
    brief,
    state: { ...initialProductState(brief, "now"), captureRuns: [failure, replacement] },
    briefText: "",
    stateText: "",
  };
}
const resolution = {
  runId: "failure",
  replacementRunId: "replacement",
  outcome: "O001",
  reason: "Observe terminal victory instead of ready-to-launch state",
  evidence: ["observation", "pixels"],
};
const catalogue: ProductEvidenceCatalogue = {
  entries: [
    {
      id: "observation",
      kind: "operation",
      status: "available",
      summary: "Observed victory",
      outcomes: [],
    },
    { id: "pixels", kind: "image", status: "available", summary: "Win", outcomes: [] },
  ],
  sources: [],
  sourceClaims: [],
  aliases: new Map(),
};

it("does not resolve a failed pointer path with successful keyboard progression", () => {
  const r = record();
  r.state.captureRuns = [
    {
      ...failure,
      failure: {
        kind: "behavior",
        message: "#next-level: control moved during pointer travel",
        operationId: "position",
      },
      operations: [
        { id: "pointer", kind: "pointer", description: "Move pointer to 100,200" },
        { id: "position", kind: "measure" },
      ],
    },
    {
      ...replacement,
      operations: [
        { id: "key", kind: "keyboard", description: "Press Enter" },
        ...replacement.operations,
      ],
    },
  ];
  expect(
    validateExperimentResolutions([resolution], r, "subject", brief.slices[0], catalogue),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("bypasses the failed input") },
  });
  r.state.captureRuns[1] = {
    ...replacement,
    operations: [
      { id: "pointer-success", kind: "pointer", description: "Move pointer to 100,200" },
      ...replacement.operations,
    ],
  };
  expect(
    validateExperimentResolutions([resolution], r, "subject", brief.slices[0], catalogue),
  ).toMatchObject({ ok: true });
});

it("requires an exact later replacement, meaningful current observation, image and available reviewer evidence", () => {
  expect(
    validateExperimentResolutions([resolution], record(), "subject", brief.slices[0], catalogue),
  ).toMatchObject({ ok: true, value: [{ provenance: "agent-reported" }] });
  expect(
    validateExperimentResolutions(undefined, record(), "subject", undefined, catalogue),
  ).toMatchObject({ ok: true, value: [] });
  expect(
    validateExperimentResolutions([{}], record(), "subject", undefined, catalogue),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  expect(
    validateExperimentResolutions(
      [resolution, resolution],
      record(),
      "subject",
      undefined,
      catalogue,
    ).ok,
  ).toBe(false);
  for (const changes of [
    { status: "failed" },
    { subjectDigest: "other" },
    { version: 1 },
    { contractDigest: "different" },
    { operations: [{ id: "observation", kind: "pointer" }] },
    { captures: [{ ...image, route: "/play" }] },
    { captures: [{ ...image, viewport: { width: 1280, height: 820 } }] },
  ]) {
    const r = record();
    r.state.captureRuns = [failure, { ...replacement, ...changes }];
    expect(validateExperimentResolutions([resolution], r, "subject", undefined, catalogue).ok).toBe(
      false,
    );
  }
  const reversed = record();
  reversed.state.captureRuns.reverse();
  expect(
    validateExperimentResolutions([resolution], reversed, "subject", undefined, catalogue).ok,
  ).toBe(false);
  for (const status of ["failed", "not-delivered", "stale", "unavailable"] as const)
    expect(
      validateExperimentResolutions([resolution], record(), "subject", undefined, {
        ...catalogue,
        entries: catalogue.entries.map((entry) => ({ ...entry, status })),
      }).ok,
    ).toBe(false);
});

it("does not permit an ad hoc replay of a declared check to escape check ownership", () => {
  const journey = {
    url: "http://127.0.0.1",
    actions: [{ kind: "click" as const, selector: "#launch", capture: true }],
  };
  const r = {
    ...record(),
    brief: productBriefSchema.parse({
      ...brief,
      checks: [{ id: "C001", command: { kind: "browser-journey", journey }, outcomes: ["O001"] }],
    }),
  };
  const digest = productContractDigest(r.brief, r.brief.slices[0]);
  r.state.captureRuns = [
    { ...failure, contractDigest: digest, journeyKey: productJourneyKey(journey, "T001") },
    { ...replacement, contractDigest: digest },
  ];
  expect(validateExperimentResolutions([resolution], r, "subject", undefined, catalogue).ok).toBe(
    false,
  );
});

it("retains raw history, reuses equivalent successful reruns and restores the block after a new failure", () => {
  const r = record();
  const validated = validateExperimentResolutions([resolution], r, "subject", undefined, catalogue);
  if (!validated.ok) throw new Error(validated.error.message);
  r.state.reviews.push({
    subjectDigest: "subject",
    contractDigest,
    task: "T001",
    createdAt: "now",
    assessments: [],
    captures: [image],
    experimentResolutions: validated.value,
  });
  expect(currentFailedJourneys(r, "subject")).toEqual([]);
  expect(validateExperimentResolutions([resolution], r, "subject", undefined, catalogue).ok).toBe(
    true,
  );
  r.state.captureRuns.push({ ...replacement, id: "retry" });
  expect(currentFailedJourneys(r, "subject")).toEqual([]);
  r.state.captureRuns.push({ ...replacement, id: "new-failure", status: "failed" });
  expect(currentFailedJourneys(r, "subject").map((run) => run.id)).toEqual([
    "failure",
    "new-failure",
  ]);
  expect(experimentReviewContext(r, "subject").failures).toHaveLength(2);
  expect(currentFailedJourneys(r, "changed").map((run) => run.id)).toEqual([
    "failure",
    "new-failure",
  ]); // A code edit is not counterevidence; rerun the failed paths.
  expect(r.state.captureRuns[0]).toEqual(failure);
});

it("rejects wrong feature, task, contract, product and corrupted selection without pretending viewing is authenticated", () => {
  const selection = {
    version: 1 as const,
    feature: brief.feature,
    task: "T001",
    subjectDigest: "subject",
    contractDigest,
    images: [{ id: image.id, sha256: image.sha256 }],
  };
  expect(validateReviewSelection(selection, selection).ok).toBe(true);
  expect(validateReviewSelection({}, selection)).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID" },
  });
  for (const key of ["feature", "task", "subjectDigest", "contractDigest"])
    expect(validateReviewSelection({ ...selection, [key]: "other" }, selection)).toMatchObject({
      ok: false,
      error: { code: "EVIDENCE_FAILED" },
    });
  const wrongScope = validateReviewSelection({ ...selection, task: undefined }, selection);
  expect(wrongScope).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_FAILED", recovery: "visp review --template" },
  });
  if (!wrongScope.ok) expect(wrongScope.error.message).toContain("same --feature and --task scope");
  expect(validateSelectedImages(selection, []).ok).toBe(false);
  expect(validateSelectedImages(undefined, []).ok).toBe(true);
});

it("keeps headless work independent from browser UI capabilities", () => {
  expect(
    needsBrowser({
      ...brief,
      originalRequest: "Command line interface",
      goal: "CLI",
      slices: [
        {
          ...brief.slices[0],
          id: "T001",
          goal: "CLI",
          approach: "",
          outcomes: ["O001"],
          scope: { allowed: ["cli.ts"], expected: [], forbidden: [] },
          checks: [],
          dependsOn: [],
        },
      ],
    }),
  ).toBe(false);
  expect(needsBrowser(brief)).toBe(true);
  expect(needsBrowser({ ...brief, originalRequest: "Interface", goal: "Interface" })).toBe(true); // Scoped HTML and experience intent.
});

it("requires runner-observed success of the original control with its original input", () => {
  const r = record();
  r.state.captureRuns[0] = {
    ...failure,
    failure: { ...failure.failure, input: { kind: "click", selector: "#next" } },
  };
  for (const input of [
    { kind: "key", key: "Enter" },
    { kind: "click", selector: "#different" },
  ]) {
    r.state.captureRuns[1] = { ...replacement, completedInputs: [input] };
    expect(
      validateExperimentResolutions([resolution], r, "subject", undefined, catalogue),
    ).toMatchObject({ ok: false, error: { message: expect.stringContaining("bypasses") } });
  }
  r.state.captureRuns[1] = {
    ...replacement,
    completedInputs: [{ kind: "click", selector: "#next" }],
  };
  expect(
    validateExperimentResolutions([resolution], r, "subject", undefined, catalogue),
  ).toMatchObject({ ok: true });
  expect(currentFailedJourneys(r, "edited-source")).toHaveLength(1);
  r.state.captureRuns.push({
    ...replacement,
    id: "same-path",
    journeyKey: failure.journeyKey,
    subjectDigest: "edited-source",
  });
  expect(currentFailedJourneys(r, "edited-source")).toHaveLength(0);
});

it("retains failures through method metadata changes but allows explicit intent replacement", () => {
  const r = record();
  r.state.captureRuns = [
    { ...failure, contractDigest: "old-method", outcomeDigest: r.state.outcomeDigest },
  ];
  expect(currentFailedJourneys(r, "new-source")).toHaveLength(1);
  r.state.captureRuns.push({
    ...failure,
    id: "fixed",
    status: "completed",
    subjectDigest: "new-source",
    outcomeDigest: r.state.outcomeDigest,
  });
  expect(currentFailedJourneys(r, "new-source")).toHaveLength(0);
  r.state.captureRuns = [{ ...failure, contractDigest: "old-method", outcomeDigest: "old-intent" }];
  expect(currentFailedJourneys(r, "new-source")).toHaveLength(0);
});

it("prepares counterevidence references without inventing a diagnosis or resolving the failure", () => {
  const r = record();
  const before = JSON.stringify(r);
  const suggestions = experimentRecoverySuggestions(r, "subject", brief.slices[0], catalogue);
  expect(suggestions).toHaveLength(1);
  const draft = suggestions[0]?.submission.experimentResolutions[0];
  if (!draft) throw new Error("Missing recovery draft");
  expect(draft).toMatchObject({
    runId: "failure",
    replacementRunId: "replacement",
    reason: "",
    evidence: ["observation", "pixels"],
  });
  expect(
    validateExperimentResolutions([draft], r, "subject", brief.slices[0], catalogue),
  ).toMatchObject({ ok: false });
  expect(
    validateExperimentResolutions(
      [
        {
          ...draft,
          reason:
            "The original wait expected an enabled control after completion; the actual terminal state is correct.",
        },
      ],
      r,
      "subject",
      brief.slices[0],
      catalogue,
    ),
  ).toMatchObject({ ok: true });
  expect(JSON.stringify(r)).toBe(before);
  expect(currentFailedJourneys(r, "subject")).toHaveLength(1);
});

it("does not suggest keyboard bypasses, unselected images, stale replacements or declared-check waivers", () => {
  const r = record();
  r.state.captureRuns[0] = {
    ...failure,
    failure: { ...failure.failure, input: { kind: "click", selector: "#confirm" } },
  };
  r.state.captureRuns[1] = { ...replacement, completedInputs: [{ kind: "key", key: "Enter" }] };
  expect(experimentRecoverySuggestions(r, "subject", brief.slices[0], catalogue)).toEqual([]);
  r.state.captureRuns[1] = {
    ...replacement,
    completedInputs: [{ kind: "click", selector: "#confirm" }],
  };
  expect(experimentRecoverySuggestions(r, "subject", brief.slices[0], catalogue)).toHaveLength(1);
  for (const status of ["not-delivered", "stale", "unavailable"] as const) {
    const missing = {
      ...catalogue,
      entries: catalogue.entries.map((e) => (e.kind === "image" ? { ...e, status } : e)),
    };
    expect(experimentRecoverySuggestions(r, "subject", brief.slices[0], missing)).toEqual([]);
  }
  expect(experimentRecoverySuggestions(r, "new-source", brief.slices[0], catalogue)).toEqual([]);
  r.state.executions.push({
    id: "declared",
    assertions: "runner-observed",
    check: "C001",
    captureRunId: "failure",
    subjectDigest: "subject",
    contractDigest,
    createdAt: "now",
    command: "browser",
    status: "failed",
    exitCode: 1,
    durationMs: 1,
    output: "",
    provenance: "supervisor-executed",
  });
  expect(experimentRecoverySuggestions(r, "subject", brief.slices[0], catalogue)).toEqual([]);
});

it("resolves a revised declared assertion only after that same check executes and a reviewer diagnoses it", () => {
  const r = { ...record() };
  const journey = {
    url: "http://127.0.0.1",
    actions: [{ kind: "click" as const, selector: "#launch", capture: true }],
  };
  const revisedBrief = productBriefSchema.parse({
    ...brief,
    checks: [{ id: "C001", command: { kind: "browser-journey", journey }, outcomes: ["O001"] }],
  });
  r.brief = revisedBrief;
  const currentContract = productContractDigest(r.brief, r.brief.slices[0]);
  const revised = {
    ...replacement,
    contractDigest: currentContract,
    outcomeDigest: r.state.outcomeDigest,
    journeyKey: productJourneyKey(journey, "T001"),
  };
  r.state.captureRuns = [{ ...failure, outcomeDigest: r.state.outcomeDigest }, revised];
  const execution = {
    id: "declared",
    task: "T001",
    assertions: "runner-observed" as const,
    check: "C001",
    captureRunId: "failure",
    subjectDigest: "subject",
    contractDigest,
    createdAt: "now",
    command: "browser",
    status: "failed" as const,
    exitCode: 1,
    durationMs: 1,
    output: "",
    provenance: "supervisor-executed" as const,
  };
  r.state.executions.push(execution);
  expect(validateExperimentResolutions([resolution], r, "subject", undefined, catalogue).ok).toBe(
    false,
  );
  r.state.executions.push({
    ...execution,
    id: "corrected-check",
    captureRunId: "replacement",
    status: "passed",
    exitCode: 0,
    contractDigest: currentContract,
  });
  expect(currentFailedJourneys(r, "subject")).toHaveLength(1);
  const validated = validateExperimentResolutions([resolution], r, "subject", undefined, catalogue);
  if (!validated.ok) throw new Error(validated.error.message);
  expect(experimentRecoverySuggestions(r, "subject", r.brief.slices[0], catalogue)).toHaveLength(1);
  const history = JSON.stringify(r.state.captureRuns);
  r.state.reviews.push({
    subjectDigest: "subject",
    contractDigest: currentContract,
    task: "T001",
    createdAt: "now",
    assessments: [],
    captures: [image],
    experimentResolutions: validated.value,
  });
  expect(currentFailedJourneys(r, "subject")).toEqual([]);
  expect(JSON.stringify(r.state.captureRuns)).toBe(history);
  // A changed product or removing the declared verifier cannot reuse this diagnosis.
  expect(currentFailedJourneys(r, "changed-source")).toHaveLength(1);
  expect(
    currentFailedJourneys({ ...r, brief: { ...r.brief, checks: [] } }, "subject"),
  ).toHaveLength(1);
});
