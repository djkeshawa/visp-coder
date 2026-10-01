import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import {
  relatedReplayRuns,
  replaySuggestions,
} from "../../../../src/workflow/evidence/capture-replay.js";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import {
  currentFailedJourneys,
  pendingJourneyReplays,
} from "../../../../src/workflow/product/evidence-references.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

function fixture() {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-history",
    originalRequest: "Hold the control",
    goal: "Hold the control",
    slices: [{ id: "T001", goal: "Hold", scope: { allowed: ["index.html"] } }],
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "now"),
  };
  const journey = browserJourneySchema.parse({
    url: "http://localhost:3000",
    actions: [
      {
        kind: "drag",
        selector: "#control",
        from: { x: 10, y: 10 },
        to: { x: 10, y: 10 },
        durationMs: 80,
      },
    ],
  });
  const legacyKey = (input: typeof journey) =>
    `journey-v2:${hashValue({ url: input.url, viewport: input.viewport ?? { width: 1280, height: 720 }, task: "T001", actions: input.actions.map((action) => Object.fromEntries(Object.entries(action).filter(([key]) => !["capture", "timeoutMs", "steps", "captureDuring"].includes(key) && (key !== "durationMs" || action.kind === "wait")))) })}`;
  const failed = {
    id: "old-failure",
    version: 2,
    provenance: "runner-executed",
    task: "T001",
    subjectDigest: "old",
    contractDigest: productContractDigest(brief, brief.slices[0]),
    journey,
    journeyDigest: hashValue(journey),
    journeyKey: legacyKey(journey),
    status: "timed-out",
    failure: { kind: "behavior", message: "Held input failed" },
    captures: [],
    operations: [],
  };
  record.state.captureRuns = [failed];
  return { record, failed, journey, legacyKey };
}

it("keeps an intact legacy failure pending after a source edit without rewriting history", () => {
  const f = fixture();
  const original = JSON.stringify(f.record.state);
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(JSON.stringify(f.record.state)).toBe(original);
});

it("does not let the old timing-colliding passing gesture hide a longer failure", () => {
  const f = fixture();
  const shorter = browserJourneySchema.parse({
    ...f.journey,
    actions: [{ ...f.journey.actions[0], durationMs: 0 }],
  });
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "old-short-pass",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journey: shorter,
    journeyDigest: hashValue(shorter),
    journeyKey: f.legacyKey(shorter),
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});

it("clears the replay requirement only after a current execution of the recorded full input", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "fresh-replay",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journeyKey: productJourneyKey(f.journey, "T001"),
  });
  expect(currentFailedJourneys(f.record, "new", "T001")).toEqual([]);
  expect(pendingJourneyReplays(f.record, "new", "T001")).toEqual([]);
});

it("does not upgrade an old passing receipt into current replay credit", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "legacy-pass",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});

it("does not clear a historical failure with a tampered current replay", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "tampered",
    subjectDigest: "new",
    status: "completed",
    failure: undefined,
    journeyDigest: "tampered",
    journeyKey: productJourneyKey(f.journey, "T001"),
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
  expect(pendingJourneyReplays(f.record, "new", "T001").map((run) => run.id)).toContain(
    f.failed.id,
  );
});

it("keeps agent-proposed failed captures informational across edits, without rewriting their status", () => {
  const f = fixture();
  f.record.state.captureRuns = [
    { ...f.failed, expectation: { basis: "agent-proposed", outcomes: [] } },
  ];
  expect(currentFailedJourneys(f.record, "old", "T001")).toEqual([]);
  expect(pendingJourneyReplays(f.record, "new", "T001")).toEqual([]);
  expect(f.record.state.captureRuns[0]).toMatchObject({ status: "timed-out" });
});

it("keeps outcome-linked and declared captures obligatory even when marked agent-proposed", () => {
  const f = fixture();
  const exploratory = { ...f.failed, expectation: { basis: "agent-proposed", outcomes: ["O001"] } };
  f.record.state.captureRuns = [exploratory];
  expect(pendingJourneyReplays(f.record, "new", "T001")).toHaveLength(1);
  f.record.state.captureRuns = [
    { ...exploratory, expectation: { basis: "agent-proposed", outcomes: [] } },
  ];
  f.record.brief.checks.push({
    id: "C001",
    command: { kind: "browser-journey", journey: f.journey },
    outcomes: [],
    files: [],
    environment: "browser",
  });
  f.record.state.captureRuns = [
    {
      ...exploratory,
      journeyKey: productJourneyKey(f.journey, "T001"),
      expectation: { basis: "agent-proposed", outcomes: [] },
    },
  ];
  expect(currentFailedJourneys(f.record, "old", "T001")).toHaveLength(1);
});

it("lets required reviewer evidence retain an exploratory failure", () => {
  const f = fixture();
  f.record.state.captureRuns = [
    {
      ...f.failed,
      expectation: { basis: "agent-proposed", outcomes: [] },
      operations: [{ id: "failed-observation", kind: "observe" }],
    },
  ];
  f.record.state.reviews.push({
    subjectDigest: "old",
    contractDigest: f.failed.contractDigest,
    createdAt: "now",
    task: "T001",
    assessments: [],
    captures: [],
    feedback: {
      phase: "product",
      dimensions: [],
      resolutions: [],
      findings: [
        {
          dimension: "functional",
          problem: "The control violates the contract",
          nextCheck: "Replay the control",
          required: true,
          outcomes: [],
          evidence: ["failed-observation"],
        },
      ],
    },
  });
  expect(pendingJourneyReplays(f.record, "new", "T001")).toHaveLength(1);
});

it("does not let an unlinked rerun shed the same journey's declared ownership", () => {
  const f = fixture();
  const key = productJourneyKey(f.journey, "T001");
  f.record.state.captureRuns = [
    { ...f.failed, journeyKey: key, expectation: { basis: "declared", outcomes: ["O001"] } },
    {
      ...f.failed,
      id: "unlinked-rerun",
      journeyKey: key,
      expectation: { basis: "agent-proposed", outcomes: [] },
    },
  ];
  expect(currentFailedJourneys(f.record, "old", "T001").map((run) => run.id)).toEqual([
    "unlinked-rerun",
  ]);
  expect(pendingJourneyReplays(f.record, "new", "T001")).toHaveLength(1);
});

it("never treats an uncaught application exception as a disposable exploratory expectation", () => {
  const f = fixture();
  f.record.state.captureRuns = [
    {
      ...f.failed,
      expectation: { basis: "agent-proposed", outcomes: [] },
      operations: [
        { id: "exception", kind: "observe", description: "Uncaught application exception" },
      ],
    },
  ];
  expect(currentFailedJourneys(f.record, "old", "T001")).toHaveLength(1);
  expect(pendingJourneyReplays(f.record, "new", "T001")).toHaveLength(1);
});

it("does not let a failed unlinked rerun clear a retained legacy failure", () => {
  const f = fixture();
  f.record.state.captureRuns.push({
    ...f.failed,
    id: "new-unlinked-failure",
    subjectDigest: "new",
    journeyKey: productJourneyKey(f.journey, "T001"),
    expectation: { basis: "agent-proposed", outcomes: [] },
  });
  expect(currentFailedJourneys(f.record, "new", "T001").map((run) => run.id)).toContain(
    "new-unlinked-failure",
  );
});

it("batches one canonical failure with distinct neighbours and excludes retired or failed hypotheses", () => {
  const f = fixture();
  const neighbour = browserJourneySchema.parse({
    ...f.journey,
    actions: [...f.journey.actions, { kind: "click", selector: "#reset" }],
  });
  const speculative = browserJourneySchema.parse({
    ...f.journey,
    actions: [...f.journey.actions, { kind: "wait-for", selector: "#result", text: "won" }],
  });
  const retired = browserJourneySchema.parse({
    ...f.journey,
    actions: [...f.journey.actions, { kind: "click", selector: "#extra" }],
  });
  const make = (
    id: string,
    journey: typeof f.journey,
    status: string,
    expectation?: { basis: string; outcomes: string[] },
  ) => ({
    ...f.failed,
    id,
    journey,
    journeyDigest: hashValue(journey),
    journeyKey: productJourneyKey(journey, "T001"),
    status,
    expectation,
    failure: status === "completed" ? undefined : f.failed.failure,
  });
  f.record.state.captureRuns.push(
    make("neighbour-old", neighbour, "completed"),
    make("neighbour-latest", neighbour, "completed"),
    make("speculative", speculative, "timed-out", { basis: "agent-proposed", outcomes: [] }),
    make("retired", retired, "completed", { basis: "agent-proposed", outcomes: [] }),
  );
  f.record.state.journeyRetirements = [
    {
      runId: "retired",
      journeyDigest: hashValue(retired),
      task: "T001",
      createdAt: "now",
      reason: "Unsupported extra transition",
      provenance: "worker-reported",
    },
  ];
  expect(relatedReplayRuns(f.record, f.failed.id, "T001").map((run) => run.id)).toEqual([
    f.failed.id,
    "neighbour-latest",
  ]);
  expect(replaySuggestions(f.record, "new", "T001")?.command).toContain(
    `--replay-batch=${f.failed.id}`,
  );
  expect(replaySuggestions(f.record, "new", "T001")?.runs.map((run) => run.runId)).not.toContain(
    "speculative",
  );
});

it("can batch an intact canonical failure after a brief method revision", () => {
  const f = fixture();
  f.record.brief.checks.push({
    id: "C001",
    command: ["node", "test.mjs"],
    files: [],
    outcomes: [],
    environment: "node",
  });
  f.record.brief.slices[0]?.checks.push("C001");
  expect(productContractDigest(f.record.brief, f.record.brief.slices[0])).not.toBe(
    f.failed.contractDigest,
  );
  expect(relatedReplayRuns(f.record, f.failed.id, "T001").map((run) => run.id)).toEqual([
    f.failed.id,
  ]);
});
