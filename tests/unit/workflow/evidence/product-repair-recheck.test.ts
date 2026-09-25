import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import { productFeedbackPlan } from "../../../../src/workflow/product/feedback.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { repairRecheck } from "../../../../src/workflow/product/repair-recheck.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

function setup() {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-repair",
    originalRequest: "Cancel and retry a reservation",
    goal: "Reliable reservations",
    outcomes: [
      { id: "O001", kind: "functional", statement: "Cancellation preserves availability" },
    ],
    checks: [{ id: "C001", command: ["node", "check.mjs"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Reservation",
        outcomes: ["O001"],
        checks: ["C001"],
        scope: { allowed: ["app.js"] },
      },
    ],
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "2026-01-01"),
  };
  const journey = browserJourneySchema.parse({
    url: "http://127.0.0.1:3000/",
    actions: [{ kind: "click", selector: "#cancel" }],
  });
  const run = {
    id: "CAPRUN-original",
    provenance: "runner-executed",
    task: "T001",
    subjectDigest: "before",
    contractDigest: productContractDigest(brief, brief.slices[0]),
    comparisonEnvironment: "browser-1",
    journey,
    journeyDigest: hashValue(journey),
    status: "completed",
    captures: [{ id: "CAP-original" }],
    operations: [{ id: "OP-original", kind: "pointer", description: "Click cancel" }],
  };
  const finding = { subjectDigest: "before", evidence: ["CAP-original"] };
  record.state.captureRuns = [run];
  return { record, run, finding };
}

it("rechecks the cited successful journey instead of unrelated recent captures", () => {
  const { record, run, finding } = setup();
  record.state.captureRuns.push(
    ...Array.from({ length: 5 }, (_, i) => {
      const journey = { ...run.journey, url: `${run.journey.url}${i}` };
      return { ...run, id: `other-${i}`, journey, journeyDigest: hashValue(journey), captures: [] };
    }),
  );
  const before = JSON.stringify(record);
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    advisory: true,
    status: "not-reobserved",
    kind: "journey",
    before: { runId: run.id, status: "completed" },
    command: expect.stringContaining("--replay=CAPRUN-original"),
  });
  expect(JSON.stringify(record)).toBe(before);
});

it("keeps a pointer report open after keyboard success; matches only the recorded journey", () => {
  const { record, run, finding } = setup();
  const journey = browserJourneySchema.parse({
    ...run.journey,
    actions: [{ kind: "key", key: "Enter" }],
  });
  record.state.captureRuns.push({
    ...run,
    id: "keyboard",
    subjectDigest: "after",
    journey,
    journeyDigest: hashValue(journey),
  });
  expect(repairRecheck(record, finding, "after", "T001")?.status).toBe("not-reobserved");
  record.state.captureRuns.push({
    ...run,
    id: "replayed",
    subjectDigest: "after",
    captures: [{ id: "CAP-after" }],
  });
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    status: "observed-unassessed",
    comparison: {
      change: "compare-observations",
      before: { runId: run.id },
      after: { runId: "replayed" },
    },
  });
});

it.each(["contract", "scope", "digest", "duplicate", "subject"])(
  "does not bind an invalid %s original",
  (kind) => {
    const { record, run, finding } = setup();
    if (kind === "contract") run.contractDigest = "different";
    if (kind === "scope") run.task = "T002";
    if (kind === "digest") run.journeyDigest = "tampered";
    if (kind === "duplicate") record.state.captureRuns.push({ ...run });
    if (kind === "subject") run.subjectDigest = "unrelated";
    expect(repairRecheck(record, finding, "after", "T001")).toBeUndefined();
  },
);

it("labels environment changes and never treats a completed replay as a fixed finding", () => {
  const { record, run, finding } = setup();
  record.state.captureRuns.push({
    ...run,
    id: "replayed",
    subjectDigest: "after",
    comparisonEnvironment: "browser-2",
  });
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    status: "observed-unassessed",
    comparison: { change: "environment-unconfirmed" },
  });
  expect(
    repairRecheck(record, { ...finding, evidence: ["CODE-source"] }, "after", "T001"),
  ).toBeUndefined();
});

it("links a backend finding to its actual check execution and retains it after a passing rerun", () => {
  const { record, run } = setup();
  const execution = {
    id: "EXEC-before",
    check: "C001",
    task: "T001",
    subjectDigest: "before",
    contractDigest: run.contractDigest,
    createdAt: "2026-01-01",
    command: "node check.mjs",
    status: "passed" as const,
    exitCode: 0,
    durationMs: 1,
    output: "weak check passed",
    provenance: "supervisor-executed" as const,
    assertions: "runner-observed" as const,
    comparisonEnvironment: "node-1",
  };
  record.state.executions = [execution];
  const finding = { subjectDigest: "before", evidence: [execution.id] };
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    kind: "check",
    check: "C001",
    status: "not-reobserved",
  });
  record.state.executions.push({ ...execution, id: "EXEC-after", subjectDigest: "after" });
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    status: "observed-unassessed",
    comparison: { after: { runId: "EXEC-after" } },
  });
  record.state.reviews.push({
    subjectDigest: "before",
    task: "T001",
    contractDigest: run.contractDigest,
    createdAt: "2026-01-01",
    assessments: [],
    captures: [],
    feedback: {
      phase: "product",
      dimensions: [],
      findings: [
        {
          evidence: finding.evidence,
          dimension: "functional",
          problem: "Cancellation leaves stale state",
          nextCheck: "Cancel while pending, then retry",
          outcomes: ["O001"],
          required: false,
        },
      ],
      resolutions: [],
    },
  });
  const plan = productFeedbackPlan(record, "after", record.brief.slices[0]);
  expect(plan.findings[0]).toMatchObject({
    required: false,
    recheck: { status: "observed-unassessed" },
  });
});

it("does not credit observations preceding the reported occurrence or metadata-only edits", () => {
  const { record, run, finding } = setup();
  record.state.captureRuns.unshift({
    ...run,
    id: "earlier",
    subjectDigest: "before",
    captures: [],
    operations: [],
  });
  record.state.updatedAt = "2026-03-01";
  expect(repairRecheck(record, finding, "before", "T001")?.status).toBe("not-reobserved");
});

it("does not choose an arbitrary journey for an ambiguous capture reference", () => {
  const { record, run, finding } = setup();
  record.state.captureRuns.push({ ...run, id: "other" });
  expect(repairRecheck(record, finding, "after", "T001")).toBeUndefined();
});

it("keeps replay pointers small without copying already-recorded measurements", () => {
  const { record, run, finding } = setup();
  const heavy = {
    ...run,
    operations: [
      {
        id: "OP-original",
        description: "Click cancel",
        measurement: { json: "MEASUREMENT".repeat(2000), truncated: false },
      },
    ],
  };
  record.state.captureRuns = [heavy];
  const before = JSON.stringify(record);
  const pending = repairRecheck(record, finding, "after", "T001");
  expect(pending).toMatchObject({ before: { runId: run.id, captureIds: ["CAP-original"] } });
  expect(JSON.stringify(pending)).not.toContain("MEASUREMENT");
  expect(JSON.stringify(pending).length).toBeLessThan(1000);
  expect(JSON.stringify(record)).toBe(before);
  record.state.captureRuns.push({
    ...heavy,
    id: "replayed",
    subjectDigest: "after",
    captures: [{ id: "CAP-after" }],
  });
  expect(repairRecheck(record, finding, "after", "T001")).toMatchObject({
    status: "observed-unassessed",
    comparison: {
      before: { runId: run.id },
      after: { runId: "replayed", captureIds: ["CAP-after"] },
    },
  });
  expect(JSON.stringify(repairRecheck(record, finding, "after", "T001"))).not.toContain(
    "MEASUREMENT",
  );
});
