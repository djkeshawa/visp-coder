import { expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import type { ProductEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import {
  outstandingFeedback,
  productFeedbackPlan,
  validateProductFeedback,
} from "../../../../src/workflow/product/feedback.js";
import type { ProductFeedback } from "../../../../src/workflow/product/feedback-model.js";
import { witnessedFunctionalFailure } from "../../../../src/workflow/product/functional-resolution.js";
import {
  initialProductState,
  type ProductExecution,
  productBriefSchema,
} from "../../../../src/workflow/product/model.js";
import { findingReproductions } from "../../../../src/workflow/product/reproduction-bindings.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";

function fixture() {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-repair",
    originalRequest: "Cancel a reservation",
    goal: "Cancel correctly",
    outcomes: [{ id: "O1", kind: "functional", statement: "Cancellation releases capacity" }],
    checks: [
      {
        id: "C1",
        command: ["node", "cancel.test.mjs"],
        outcomes: ["O1"],
        files: ["cancel.test.mjs"],
      },
      {
        id: "C2",
        command: ["node", "reserve.test.mjs"],
        outcomes: ["O1"],
        verifierFiles: ["reserve.test.mjs"],
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Cancellation",
        outcomes: ["O1"],
        checks: ["C1", "C2"],
        scope: { allowed: ["app.mjs"] },
      },
    ],
  });
  const contractDigest = productContractDigest(brief, brief.slices[0]);
  const before: ProductExecution = {
    id: "failed",
    check: "C1",
    task: "T001",
    subjectDigest: "before",
    contractDigest,
    createdAt: "2026-09-21T00:00:00Z",
    command: "node cancel.test.mjs",
    provenance: "supervisor-executed",
    assertions: "agent-reported",
    status: "failed",
    exitCode: 1,
    durationMs: 10,
    output: "Capacity stayed reserved",
    verifierDigest: "a".repeat(64),
    comparisonEnvironment: "host-1",
  };
  const after: ProductExecution = {
    ...before,
    id: "passed",
    subjectDigest: "after",
    status: "passed",
    exitCode: 0,
  };
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "now"),
  };
  const regression: ProductExecution = {
    ...after,
    id: "regression",
    check: "C2",
    command: "node reserve.test.mjs",
    verifierDigest: "b".repeat(64),
  };
  record.state.executions = [before, after, regression];
  record.state.reviews = [
    {
      policyVersion: 4,
      task: "T001",
      subjectDigest: "before",
      contractDigest,
      createdAt: "now",
      assessments: [],
      captures: [],
      feedback: {
        phase: "product",
        dimensions: [],
        resolutions: [],
        findings: [
          {
            dimension: "functional",
            required: true,
            problem: "Capacity stays reserved",
            nextCheck: "Cancel then reserve again",
            outcomes: ["O1"],
            evidence: ["failed"],
          },
        ],
      },
    },
  ];
  const catalogue: ProductEvidenceCatalogue = {
    entries: [
      { id: "passed", kind: "execution", status: "available", outcomes: ["O1"], summary: "Passed" },
      {
        id: "regression",
        kind: "execution",
        status: "available",
        outcomes: ["O1"],
        summary: "Reservation still works",
      },
    ],
    aliases: new Map(),
    sources: [],
    sourceClaims: [],
  };
  const resolution: ProductFeedback["resolutions"][number] = {
    id: outstandingFeedback(record)[0]?.id ?? "missing",
    explanation: "Cancellation repaired",
    evidence: ["passed"],
    regression: {
      kind: "checked",
      explanation: "Creating a reservation still consumes the released capacity",
      evidence: ["regression"],
    },
  };
  const assess = (slice = brief.slices[0]) =>
    validateProductFeedback(
      { phase: "product", dimensions: [], resolutions: [resolution] },
      record,
      catalogue,
      { context: "current" },
      slice,
    );
  return { record, before, after, regression, catalogue, resolution, assess };
}

it("retains a finding when fresh evidence has no recorded execution", () => {
  const f = fixture();
  f.record.state.executions = [];
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it.each([
  { check: "C2" },
  { command: "node syntax-only.mjs" },
  { task: undefined },
  { contractDigest: "different" },
  { status: "failed" },
  { exitCode: 1 },
  { provenance: "supervisor-reused" },
])("retains the finding for an unrelated or unsuccessful recheck %j", (change) => {
  const f = fixture();
  Object.assign(f.after, change);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("does not treat a contradictory failure receipt as a reproduction", () => {
  const f = fixture();
  f.before.exitCode = 0;
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("requires a failed reproduction, not merely an earlier successful command", () => {
  const f = fixture();
  f.before.status = "passed";
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("rejects duplicate receipt identities", () => {
  const f = fixture();
  f.record.state.executions.push({ ...f.after });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it.each([undefined, "b".repeat(64)])(
  "rejects a missing or changed verifier digest %s",
  (digest) => {
    const f = fixture();
    f.after.verifierDigest = digest;
    expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
  },
);

it("does not resolve automatically when the recheck passes", () => {
  const f = fixture();
  expect(outstandingFeedback(f.record)).toHaveLength(1);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
  expect(outstandingFeedback(f.record)).toHaveLength(1);
});

it("does not select an earlier command pass after the same check fails again", () => {
  const f = fixture();
  f.record.state.executions.push({
    ...f.after,
    id: "later-failed",
    status: "failed",
    exitCode: 1,
    output: "Capacity stayed reserved again",
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("can assess a new command pass after a later failed recheck", () => {
  const f = fixture();
  f.record.state.executions.push({ ...f.after, id: "later-failed", status: "failed", exitCode: 1 });
  f.record.state.executions.push({ ...f.after, id: "latest-passed" });
  f.resolution.evidence = ["latest-passed"];
  Object.assign(f.catalogue, {
    entries: [
      ...f.catalogue.entries,
      {
        id: "latest-passed",
        kind: "execution",
        status: "available",
        outcomes: ["O1"],
        summary: "Latest passing recheck",
      },
    ],
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it.each([undefined, "", "host-2"])(
  "does not attribute a command pass to repair with environment %s",
  (environment) => {
    const f = fixture();
    f.after.comparisonEnvironment = environment;
    expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
  },
);

it("does not consider two unknown command environments comparable", () => {
  const f = fixture();
  f.before.comparisonEnvironment = undefined;
  f.after.comparisonEnvironment = undefined;
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("retains a repaired finding without adjacent regression evidence or assessed non-applicability", () => {
  const f = fixture();
  Object.assign(f.resolution, { regression: undefined });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("accepts an explicit assessed reason when an adjacent regression does not apply", () => {
  const f = fixture();
  Object.assign(f.resolution, {
    regression: {
      kind: "not-applicable",
      explanation:
        "This change only replaces a constant; its complete behavior is covered by the fixed assertion",
    },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it.each([
  { status: "failed" },
  { exitCode: 1 },
  { subjectDigest: "before" },
  { task: "T002" },
  { contractDigest: "old" },
  { verifierDigest: undefined },
  { command: "node cancel.test.mjs" },
])("rejects invalid or duplicated adjacent regression evidence %j", (change) => {
  const f = fixture();
  Object.assign(f.regression, change);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("does not count the repair recheck itself as an adjacent regression", () => {
  const f = fixture();
  Object.assign(f.resolution, {
    regression: { kind: "checked", explanation: "Same execution", evidence: ["passed"] },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("does not turn a second check label for the same command into adjacent coverage", () => {
  const f = fixture();
  const duplicate = f.record.brief.checks.find((check) => check.id === "C2");
  if (!duplicate) throw new Error("Missing check");
  duplicate.command = ["node", "cancel.test.mjs"];
  f.regression.command = f.after.command;
  const contract = productContractDigest(f.record.brief, f.record.brief.slices[0]);
  for (const execution of f.record.state.executions) execution.contractDigest = contract;
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("normalizes check aliases for both repair and regression receipts", () => {
  const f = fixture();
  Object.assign(f.catalogue, {
    aliases: new Map([
      ["C1", "passed"],
      ["C2", "regression"],
    ]),
  });
  f.resolution.evidence = ["C1"];
  Object.assign(f.resolution, {
    regression: { kind: "checked", explanation: "Reservation still works", evidence: ["C2"] },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it("matches the actual repair when its citation list also includes the adjacent check", () => {
  const f = fixture();
  f.resolution.evidence.push("regression");
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it("rejects an empty non-applicability explanation", () => {
  const f = fixture();
  Object.assign(f.resolution, { regression: { kind: "not-applicable", explanation: " " } });
  expect(f.assess()).toMatchObject({ ok: false });
});

it("keeps the original required reproduction when a later review weakens the same finding", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing finding");
  f.record.state.reviews.push({
    ...original,
    subjectDigest: "after",
    feedback: {
      ...original.feedback,
      findings: original.feedback.findings.map((finding) => ({
        ...finding,
        required: false,
        evidence: ["passed"],
      })),
    },
  });
  expect(outstandingFeedback(f.record)).toMatchObject([
    { required: true, subjectDigest: "before", evidence: ["failed"], repeats: 2 },
  ]);
});

it("keeps identical findings from separate slices distinct", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original) throw new Error("Missing review");
  Object.assign(original, { findingIdentityVersion: 2 });
  f.record.state.reviews.push({ ...original, task: "T002" });
  const findings = outstandingFeedback(f.record);
  expect(findings).toHaveLength(2);
  expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
});

it("preserves colliding historical findings without rewriting their reviews", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, task: "T002" });
  const saved = JSON.stringify(f.record.state);
  const findings = outstandingFeedback(f.record);
  expect(findings.map((finding) => finding.task)).toEqual(["T001", "T002"]);
  expect(new Set(findings.map((finding) => finding.id)).size).toBe(2);
  expect(JSON.stringify(f.record.state)).toBe(saved);
});

it.each(["T001", "T002"])("scopes an old collision resolution to %s", (task) => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, task: "T002" });
  f.record.state.reviews.push({
    ...original,
    task,
    feedback: { ...original.feedback, findings: [], resolutions: [f.resolution] },
  });
  expect(outstandingFeedback(f.record).map((finding) => finding.task)).toEqual([
    task === "T001" ? "T002" : "T001",
  ]);
});

it("does not guess which slice an ambiguous feature-wide historical resolution meant", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, task: "T002" });
  f.record.state.reviews.push({
    ...original,
    task: undefined,
    feedback: { ...original.feedback, findings: [], resolutions: [f.resolution] },
  });
  expect(outstandingFeedback(f.record)).toHaveLength(2);
});

it("repeats a scoped historical collision with the current identity", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, task: "T002" });
  f.record.state.reviews.push({ ...original, findingIdentityVersion: 2 });
  expect(outstandingFeedback(f.record)).toMatchObject([
    { task: "T001", repeats: 2 },
    { task: "T002", repeats: 1 },
  ]);
});

it("retains old reproduction links only for the collision's actual owner", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reproductions = [
    {
      version: 1,
      finding: f.resolution.id,
      findingSubject: "before",
      execution: f.before.id,
      executionDigest: hashValue(f.before),
      explanation: "Observed cancellation failure",
      createdAt: "2026-09-22T00:00:00Z",
      provenance: "caller-reported",
    },
  ];
  f.record.state.reviews.push({ ...original, task: "T002" });
  const findings = outstandingFeedback(f.record);
  const owner = findings.find((finding) => finding.task === "T001");
  const other = findings.find((finding) => finding.task === "T002");
  if (!owner || !other) throw new Error("Missing owners");
  expect(findingReproductions(f.record, owner)).toHaveLength(1);
  expect(findingReproductions(f.record, other)).toEqual([]);
});

it("allows an explicit current resolution of a recovered collision identity", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, task: "T002" });
  const owner = outstandingFeedback(f.record).find((finding) => finding.task === "T002");
  if (!owner) throw new Error("Missing owner");
  f.record.state.reviews.push({
    ...original,
    task: undefined,
    findingIdentityVersion: 2,
    feedback: {
      ...original.feedback,
      findings: [],
      resolutions: [{ ...f.resolution, id: owner.id }],
    },
  });
  expect(outstandingFeedback(f.record).map((finding) => finding.task)).toEqual(["T001"]);
});

it("cannot disprove a slice finding with another slice's valid execution", () => {
  const f = fixture();
  const first = f.record.brief.slices[0];
  if (!first) throw new Error("Missing slice");
  const slice = { ...first, id: "T002" };
  f.record.brief.slices.push(slice);
  f.after.task = slice.id;
  f.after.contractDigest = productContractDigest(f.record.brief, slice);
  f.resolution.disposition = "disproved";
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("cannot resolve another slice's finding through the current slice's review", () => {
  const f = fixture();
  const first = f.record.brief.slices[0];
  if (!first) throw new Error("Missing slice");
  const slice = { ...first, id: "T002" };
  f.record.brief.slices.push(slice);
  f.resolution.disposition = "disproved";
  expect(f.assess(slice)).toMatchObject({ ok: true, value: { resolutions: [] } });
  expect(productFeedbackPlan(f.record, "after", slice).findings).toEqual([]);
  expect(productFeedbackPlan(f.record, "after", first).findings).toHaveLength(1);
  expect(productFeedbackPlan(f.record, "after").findings[0]?.recheck).toMatchObject({
    kind: "check",
    status: "observed-unassessed",
  });
});

it("retains an unresolved historical identity when the same slice repeats it with new identity rules", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original) throw new Error("Missing review");
  f.record.state.reviews.push({ ...original, findingIdentityVersion: 2 });
  expect(outstandingFeedback(f.record)).toMatchObject([
    { id: f.resolution.id, task: "T001", repeats: 2 },
  ]);
});

it("does not reopen a resolved historical finding when new identity rules are used later", () => {
  const f = fixture();
  const original = f.record.state.reviews[0];
  if (!original?.feedback) throw new Error("Missing review");
  f.record.state.reviews.push({
    ...original,
    feedback: { ...original.feedback, findings: [], resolutions: [f.resolution] },
  });
  f.record.state.reviews.push({
    ...original,
    findingIdentityVersion: 2,
    feedback: { ...original.feedback, findings: [] },
  });
  expect(outstandingFeedback(f.record)).toEqual([]);
});

it("allows an explicit assessed disproof without inventing a failed reproduction", () => {
  const f = fixture();
  f.record.state.executions = [f.after];
  Object.assign(f.resolution, { disposition: "disproved" });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
  expect(outstandingFeedback(f.record)).toHaveLength(1);
});

it.each([
  { status: "failed" },
  { exitCode: 1 },
  { verifierDigest: undefined },
  { contractDigest: "stale" },
  { contractDigest: undefined },
  { provenance: "supervisor-reused" },
])("requires witnessed, applicable counterevidence for disproof %j", (change) => {
  const f = fixture();
  Object.assign(f.resolution, { disposition: "disproved" });
  Object.assign(f.after, change);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("rejects unknown resolution dispositions instead of treating them as a disproof", () => {
  const f = fixture();
  Object.assign(f.resolution, { disposition: "disprove" });
  expect(f.assess()).toMatchObject({ ok: false });
});

function browserDisproof() {
  const f = fixture();
  const journey = browserJourneySchema.parse({
    url: "http://127.0.0.1:3000/",
    actions: [{ kind: "wait-for", selector: "#capacity", text: "1" }],
  });
  const check = f.record.brief.checks[0];
  if (!check) throw new Error("Missing check");
  check.command = { kind: "browser-journey", journey };
  f.after.command = `browser-journey ${journey.url}`;
  f.after.verifierDigest = undefined;
  f.after.captureRunId = "run";
  f.after.contractDigest = productContractDigest(f.record.brief, f.record.brief.slices[0]);
  const run = {
    id: "run",
    version: 2,
    provenance: "runner-executed",
    subjectDigest: f.after.subjectDigest,
    contractDigest: f.after.contractDigest,
    comparisonEnvironment: "browser-1",
    task: f.after.task,
    journey,
    journeyDigest: hashValue(journey),
    journeyKey: productJourneyKey(journey, f.after.task),
    status: "completed",
    captures: [],
    operations: [],
  };
  f.record.state.captureRuns = [run];
  Object.assign(f.resolution, { disposition: "disproved" });
  return { ...f, run };
}

it("accepts assessed browser counterevidence through its actual execution and intact journey", () => {
  const f = browserDisproof();
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it("does not disprove a functional finding from a browser pass superseded by a failed replay", () => {
  const f = browserDisproof();
  f.record.state.captureRuns.push({
    ...f.run,
    id: "later-failed",
    status: "failed",
    failure: { kind: "behavior", message: "Capacity stayed reserved again" },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("can disprove a finding with a newly executed browser pass after the failure", () => {
  const f = browserDisproof();
  f.record.state.captureRuns.push({
    ...f.run,
    id: "later-failed",
    status: "failed",
    failure: { kind: "behavior", message: "Capacity stayed reserved again" },
  });
  f.record.state.captureRuns.push({ ...f.run, id: "latest-passed" });
  f.record.state.executions.push({
    ...f.after,
    id: "latest-execution",
    captureRunId: "latest-passed",
  });
  f.resolution.evidence = ["latest-execution"];
  Object.assign(f.catalogue, {
    entries: [
      ...f.catalogue.entries,
      {
        id: "latest-execution",
        kind: "execution",
        status: "available",
        outcomes: ["O1"],
        summary: "Fresh passing counterexample",
      },
    ],
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

function browserRepair() {
  const f = browserDisproof();
  const original = {
    ...f.run,
    id: "original",
    subjectDigest: "before",
    status: "failed",
    failure: { kind: "behavior", message: "Capacity stayed reserved" },
  };
  f.record.state.captureRuns.unshift(original);
  Object.assign(f.before, {
    captureRunId: original.id,
    contractDigest: f.after.contractDigest,
    command: f.after.command,
    verifierDigest: undefined,
  });
  f.regression.contractDigest = f.after.contractDigest;
  f.resolution.disposition = "repaired";
  return { ...f, original };
}

it("accepts browser repair in the same observed browser environment", () => {
  const f = browserRepair();
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it("does not resolve a browser finding from an earlier pass after the same replay fails again", () => {
  const f = browserRepair();
  f.record.state.captureRuns.push({
    ...f.run,
    id: "later-failed",
    status: "failed",
    failure: { kind: "behavior", message: "Capacity stayed reserved again" },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("can assess a fresh browser replay after the later failure is repaired", () => {
  const f = browserRepair();
  f.record.state.captureRuns.push({
    ...f.run,
    id: "later-failed",
    status: "failed",
    failure: { kind: "behavior", message: "Capacity stayed reserved again" },
  });
  f.record.state.captureRuns.push({ ...f.run, id: "latest-passed" });
  f.record.state.executions.push({
    ...f.after,
    id: "latest-execution",
    captureRunId: "latest-passed",
  });
  f.resolution.evidence = ["latest-execution"];
  Object.assign(f.catalogue, {
    entries: [
      ...f.catalogue.entries,
      {
        id: "latest-execution",
        kind: "execution",
        status: "available",
        outcomes: ["O1"],
        summary: "Latest passing browser replay",
      },
    ],
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it.each([undefined, "", "browser-2"])(
  "rejects browser repair in an unknown or changed browser %s",
  (environment) => {
    const f = browserRepair();
    Object.assign(f.run, { comparisonEnvironment: environment });
    expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
  },
);

it.each([{ subjectDigest: "wrong" }, { status: "failed" }, { journeyDigest: "altered" }])(
  "rejects invalid linked browser counterevidence %j",
  (change) => {
    const f = browserDisproof();
    Object.assign(f.run, change);
    expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
  },
);

function laterReproduction() {
  const f = fixture();
  const report = f.record.state.reviews[0]?.feedback?.findings[0];
  if (!report) throw new Error("Missing finding fixture");
  report.evidence = [];
  f.before.subjectDigest = "reproduced-later";
  const attachment = {
    version: 1,
    finding: f.resolution.id,
    findingSubject: "before",
    execution: f.before.id,
    executionDigest: hashValue(f.before),
    explanation: "The added cancellation assertion observes the reported reserved capacity",
    createdAt: "2026-09-22T00:00:00Z",
    provenance: "caller-reported",
  };
  Object.assign(f.record.state, { reproductions: [attachment] });
  return { ...f, attachment };
}

it("assesses repair of a later attached reproduction without rewriting the original finding", () => {
  const f = laterReproduction();
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
  expect(outstandingFeedback(f.record)[0]).toMatchObject({ subjectDigest: "before", evidence: [] });
  expect(
    productFeedbackPlan(f.record, "after", f.record.brief.slices[0]).findings[0],
  ).toMatchObject({ reproductions: [{ execution: "failed", subjectDigest: "reproduced-later" }] });
});

it.each([
  { findingSubject: "other-report" },
  { finding: "other-finding" },
  { executionDigest: "tampered" },
  { execution: "missing" },
  { provenance: "reviewer-approved" },
])("rejects an invalid later reproduction attachment %j", (patch) => {
  const f = laterReproduction();
  Object.assign(f.attachment, patch);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("rejects a changed failure receipt after attachment", () => {
  const f = laterReproduction();
  f.before.output = "A different failure";
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it.each([
  { status: "passed", exitCode: 0 },
  { status: "environment-failed" },
  { exitCode: 0 },
  { provenance: "supervisor-reused" },
  { task: "T002" },
  { verifierDigest: undefined },
  { comparisonEnvironment: undefined },
  { contractDigest: "stale" },
  { command: "node --check app.mjs" },
])("does not attach an invalid failed witness %j", (patch) => {
  const f = fixture();
  Object.assign(f.before, patch);
  const finding = outstandingFeedback(f.record)[0];
  if (!finding) throw new Error("Missing finding");
  expect(witnessedFunctionalFailure(f.record, finding, f.before.id, "before")).toBeUndefined();
});

it("does not use a syntax-only failure and pass as a functional repair witness", () => {
  const f = fixture();
  const check = f.record.brief.checks.find((entry) => entry.id === "C1");
  if (!check) throw new Error("Missing check");
  check.command = ["node", "--check", "app.mjs"];
  f.before.command = f.after.command = "node --check app.mjs";
  const contract = productContractDigest(f.record.brief, f.record.brief.slices[0]);
  for (const execution of f.record.state.executions) execution.contractDigest = contract;
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

function declaredEnvironmentRepair() {
  const f = fixture();
  f.after.comparisonEnvironment = "host-2";
  Object.assign(f.resolution, {
    environmentChange: {
      from: "host-1",
      to: "host-2",
      explanation:
        "The corrected runtime configuration repairs cancellation; the same verifier and nearby reservation check pass.",
    },
  });
  return f;
}

it("accepts an explicitly assessed environment repair with an unchanged verifier", () => {
  const f = declaredEnvironmentRepair();
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
});

it.each([
  { comparisonEnvironment: undefined },
  { comparisonEnvironment: "host-3" },
  { verifierDigest: "c".repeat(64) },
  { status: "failed", exitCode: 1 },
])("does not use environment assessment to excuse invalid repair evidence %j", (change) => {
  const f = declaredEnvironmentRepair();
  Object.assign(f.after, change);
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("still requires adjacent regression assessment for an environment repair", () => {
  const f = declaredEnvironmentRepair();
  f.resolution.regression = undefined;
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("does not mix an environment repair claim with disproof", () => {
  const f = declaredEnvironmentRepair();
  f.resolution.disposition = "disproved";
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("accepts assessed browser environment repair while preserving the exact journey", () => {
  const f = browserRepair();
  f.run.comparisonEnvironment = "browser-2";
  Object.assign(f.resolution, {
    environmentChange: {
      from: "browser-1",
      to: "browser-2",
      explanation:
        "The browser configuration was repaired without changing the interaction or expected result.",
    },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [f.resolution] } });
  f.run.journeyDigest = "changed";
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it.each([
  { from: "wrong", to: "host-2" },
  { from: "host-1", to: "wrong" },
  { from: "host-1", to: "host-1" },
])("requires the assessed environment identities to match the actual pair %j", (change) => {
  const f = declaredEnvironmentRepair();
  Object.assign(f.resolution, {
    environmentChange: { ...change, explanation: "Claimed environment repair" },
  });
  expect(f.assess()).toMatchObject({ ok: true, value: { resolutions: [] } });
});

it("requires a nonempty rationale for an environment repair", () => {
  const f = declaredEnvironmentRepair();
  Object.assign(f.resolution, {
    environmentChange: { from: "host-1", to: "host-2", explanation: " " },
  });
  expect(f.assess()).toMatchObject({ ok: false });
});
