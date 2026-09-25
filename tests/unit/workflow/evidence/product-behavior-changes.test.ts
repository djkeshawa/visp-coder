import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import {
  captureBehaviorChange,
  checkBehaviorChanges,
} from "../../../../src/workflow/product/behavior-changes.js";
import { executionSchema } from "../../../../src/workflow/product/model.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";

const run = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  version: 2,
  provenance: "runner-executed",
  subjectDigest: id,
  contractDigest: "contract",
  comparisonEnvironment: "environment",
  task: "T001",
  journeyDigest: "same-pointer-input-and-expectations",
  status: "completed",
  captures: [],
  operations: [],
  ...patch,
});
const record = (...captureRuns: unknown[]) => ({ state: { captureRuns } }) as ProductRecord;

it("compares revised observations of the same inputs without crediting them as recovery", () => {
  const captured = (id: string, text: string, input = "click") => {
    const journey = browserJourneySchema.parse({
      url: "http://127.0.0.1:3000/",
      actions: [
        { kind: input, selector: "#save" },
        { kind: "wait-for", selector: "#status", text },
      ],
    });
    return run(id, {
      journey,
      journeyDigest: hashValue(journey),
      status: id === "before" ? "timed-out" : "completed",
      ...(id === "before"
        ? { failure: { kind: "behavior", message: "Expected exact status was not observed" } }
        : {}),
    });
  };
  const before = captured("before", "Saved");
  const after = captured("after", "Saved successfully");
  const history = record(before);
  expect(captureBehaviorChange(history, after)).toMatchObject({
    change: "revised-observation",
    sameJourney: false,
    before: { runId: "before", status: "timed-out" },
    after: { runId: "after", status: "completed" },
  });
  expect(
    captureBehaviorChange(history, captured("touch", "Saved successfully", "tap")),
  ).toBeUndefined();
  expect(captureBehaviorChange(history, { ...after, journeyDigest: "tampered" })).toBeUndefined();
  expect(captureBehaviorChange(history, { ...after, task: "T002" })).toBeUndefined();
  expect(
    captureBehaviorChange(history, { ...after, contractDigest: "revised intent" }),
  ).toBeUndefined();
  expect(
    captureBehaviorChange(history, { ...after, comparisonEnvironment: "other" }),
  ).toMatchObject({
    change: "environment-unconfirmed",
    sameJourney: false,
  });
  expect(
    captureBehaviorChange(history, {
      ...after,
      failure: { kind: "environment", message: "Browser unavailable" },
    }),
  ).toMatchObject({
    change: "execution-gap",
    sameJourney: false,
  });
  expect(history.state.captureRuns).toEqual([before]);
});

it("reports a possible regression from identical ordinary input without changing evidence or acceptance", () => {
  const before = run("before");
  const after = run("after", {
    status: "timed-out",
    failure: { kind: "behavior", message: "Second action did not become available" },
    operations: [
      {
        id: "measurement",
        kind: "observe",
        measurement: { json: '{"remaining":2}', truncated: false },
      },
    ],
  });
  const history = record(before);
  expect(captureBehaviorChange(history, after)).toMatchObject({
    change: "possible-regression",
    sameSubject: false,
    before: { runId: "before" },
    after: {
      runId: "after",
      detail: "Second action did not become available",
      measurements: [{ json: '{"remaining":2}' }],
    },
  });
  expect(history.state.captureRuns).toEqual([before]);
});

it.each([
  { task: "T002" },
  { journeyDigest: "keyboard-instead-of-pointer" },
  { contractDigest: "weakened-expectation" },
])("does not pair different scope, input or contracts: %j", (patch) => {
  expect(captureBehaviorChange(record(run("before")), run("after", patch))).toBeUndefined();
});

it("keeps environment uncertainty and execution failures distinct from product regressions", () => {
  expect(
    captureBehaviorChange(record(run("old", { comparisonEnvironment: undefined })), run("new"))
      ?.change,
  ).toBe("environment-unconfirmed");
  expect(
    captureBehaviorChange(record(run("old")), run("new", { comparisonEnvironment: "changed" }))
      ?.change,
  ).toBe("environment-unconfirmed");
  expect(
    captureBehaviorChange(
      record(run("old")),
      run("new", {
        status: "failed",
        failure: { kind: "environment", message: "Browser disconnected" },
      }),
    )?.change,
  ).toBe("execution-gap");
});

it("uses the immediately preceding matching run and calls recovery execution, not quality", () => {
  expect(
    captureBehaviorChange(
      record(
        run("first"),
        run("failed", {
          status: "failed",
          failure: { kind: "behavior", message: "Missing result" },
        }),
      ),
      run("repaired"),
    ),
  ).toMatchObject({ change: "recovered-execution", before: { runId: "failed" } });
});

const execution = (id: string, patch: Record<string, unknown> = {}) =>
  executionSchema.parse({
    id,
    check: "C001",
    task: "T001",
    subjectDigest: id,
    contractDigest: "contract",
    comparisonEnvironment: "environment",
    command: "node check.mjs",
    createdAt: "2026-01-01",
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    output: "available=4",
    provenance: "supervisor-executed",
    assertions: "agent-reported",
    ...patch,
  });
it("shows backend output differences even when both commands pass, without inventing a failure", () => {
  expect(
    checkBehaviorChanges([execution("before")], [execution("after", { output: "available=5" })]),
  ).toMatchObject({
    checks: [
      {
        check: "C001",
        change: "compare-observations",
        outputChanged: true,
        before: { detail: "available=4" },
        after: { detail: "available=5" },
      },
    ],
  });
  expect(
    checkBehaviorChanges(
      [execution("before")],
      [execution("after", { command: "node weaker-check.mjs" })],
    ),
  ).toEqual({ checks: [], omitted: 0 });
  expect(
    checkBehaviorChanges(
      [execution("before")],
      [execution("after", { provenance: "supervisor-reused" })],
    ),
  ).toEqual({ checks: [], omitted: 0 });
});

it("does not label host cancellation as a product regression", () => {
  expect(
    captureBehaviorChange(record(run("old")), run("new", { status: "cancelled" }))?.change,
  ).toBe("execution-gap");
});

it("keeps feedback bounded and prioritizes a possible regression over routine output changes", () => {
  const before = Array.from({ length: 5 }, (_, index) =>
    execution(`before-${index}`, { check: `C00${index}` }),
  );
  const after = before.map((entry, index) =>
    execution(`after-${index}`, {
      check: entry.check,
      status: index === 4 ? "failed" : "passed",
      output: "changed observation",
    }),
  );
  const result = checkBehaviorChanges(before, after);
  expect(result.checks).toHaveLength(3);
  expect(result.omitted).toBe(2);
  expect(result.checks[0]).toMatchObject({ check: "C004", change: "possible-regression" });
  expect(checkBehaviorChanges([execution("before")], [execution("after")])).toEqual({
    checks: [],
    omitted: 0,
  });
});

it("ignores malformed history and exposes truncation instead of presenting a partial observation as complete", () => {
  expect(captureBehaviorChange(record(), { invalid: true })).toBeUndefined();
  expect(
    captureBehaviorChange(record(), run("missing-contract", { contractDigest: undefined })),
  ).toBeUndefined();
  const result = captureBehaviorChange(
    record({ invalid: true }, run("old")),
    run("new", {
      status: "timed-out",
      failure: { kind: "behavior", message: "x".repeat(2000) },
      operations: [
        {
          id: "large",
          kind: "observe",
          description: "Measured response",
          measurement: { json: "y".repeat(2000), truncated: false },
        },
      ],
    }),
  );
  expect(result?.after).toMatchObject({
    detailTruncated: true,
    measurements: [{ truncated: true }],
  });
  expect(result?.after.detail).toHaveLength(1200);
  expect(result?.after.measurements[0]?.json).toHaveLength(1200);
  expect(
    captureBehaviorChange(record(run("old")), run("new", { status: "timed-out" }))?.change,
  ).toBe("execution-gap");
});

it("offers only intact matching historical journeys, caps suggestions, and stops suggesting a current replay", async () => {
  const { replaySuggestions } = await import("../../../../src/workflow/evidence/capture-replay.js");
  const { browserJourneySchema } = await import("../../../../src/testing/browser-journey.js");
  const { hashValue } = await import("../../../../src/core/hash.js");
  const { productBriefSchema, initialProductState } = await import(
    "../../../../src/workflow/product/model.js"
  );
  const { productContractDigest } = await import("../../../../src/workflow/product/subject.js");
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-replay",
    originalRequest: "Usable service",
    goal: "Usable service",
    outcomes: [{ id: "O001", kind: "functional", statement: "Usable service" }],
    slices: [{ id: "T001", goal: "Service", outcomes: ["O001"], scope: { allowed: ["app.js"] } }],
  });
  const records: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "2026-01-01"),
  };
  const journey = browserJourneySchema.parse({ url: "http://127.0.0.1:3000/" });
  const entry = {
    id: "CAPRUN-old",
    provenance: "runner-executed",
    subjectDigest: "old",
    task: "T001",
    status: "completed",
    contractDigest: productContractDigest(brief, brief.slices[0]),
    journey,
    journeyDigest: hashValue(journey),
  };
  for (const patch of [
    { task: "T002" },
    { contractDigest: "changed" },
    { journeyDigest: "altered" },
    { id: "$(command)" },
  ]) {
    records.state.captureRuns = [{ ...entry, ...patch }];
    expect(replaySuggestions(records, "current", "T001")).toBeUndefined();
  }
  records.state.captureRuns = Array.from({ length: 5 }, (_, index) => {
    const next = { ...journey, url: `${journey.url}${index}` };
    return { ...entry, id: `CAPRUN-${index}`, journey: next, journeyDigest: hashValue(next) };
  });
  expect(replaySuggestions(records, "current", "T001")).toMatchObject({
    advisory: true,
    runs: expect.any(Array),
    omitted: 2,
  });
  expect(replaySuggestions(records, "current", "T001")?.runs).toHaveLength(3);
  records.state.captureRuns = [entry, { ...entry, id: "CAPRUN-new", subjectDigest: "current" }];
  expect(replaySuggestions(records, "current", "T001")).toBeUndefined();
});
