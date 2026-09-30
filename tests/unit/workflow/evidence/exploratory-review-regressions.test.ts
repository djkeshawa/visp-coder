import { afterEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import * as hashing from "../../../../src/core/hash.js";
import { hashValue } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { browserJourneySchema } from "../../../../src/testing/browser-journey.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { productJourneyKey } from "../../../../src/workflow/evidence/product-journey.js";
import { describeProductCheck } from "../../../../src/workflow/product/check-command.js";
import { criticStateSchema } from "../../../../src/workflow/product/critic-model.js";
import { criticPacket } from "../../../../src/workflow/product/critic-packet.js";
import { criticSelection } from "../../../../src/workflow/product/critic-store.js";
import {
  currentFailedJourneys,
  pendingJourneyReplays,
  productEvidenceCatalogue,
} from "../../../../src/workflow/product/evidence-references.js";
import { experimentReviewContext } from "../../../../src/workflow/product/experiments.js";
import { validateProductFeedback } from "../../../../src/workflow/product/feedback.js";
import { openRequiredFindings } from "../../../../src/workflow/product/findings.js";
import { findFunctionalRepair } from "../../../../src/workflow/product/functional-resolution.js";
import { journeyOwnershipIndex } from "../../../../src/workflow/product/journey-ownership.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { repairRecheck } from "../../../../src/workflow/product/repair-recheck.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import {
  independentReviewerContext,
  runProductReviewerHandoff,
} from "../../../../src/workflow/product/reviewer-handoff.js";
import {
  type ProductRecord,
  readProductRecord,
  saveProductState,
} from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../src/testing/browser-journey.js", async (original) => ({
  ...(await original<object>()),
  runBrowserJourney: runner.run,
}));
const workspaces: Awaited<ReturnType<typeof productWorkspace>>["workspace"][] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((w) => w.destroy()));
  runner.run.mockReset();
  vi.restoreAllMocks();
});

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function failure(brief: ProductBrief, subject: string, id = "failed") {
  const journey = browserJourneySchema.parse({
    url: "http://localhost:3000/",
    actions: [{ kind: "wait-for", selector: "#result", text: "2" }],
  });
  return {
    id,
    version: 2,
    provenance: "runner-executed",
    task: "T001",
    subjectDigest: subject,
    contractDigest: productContractDigest(brief, brief.slices[0]),
    journey,
    journeyDigest: hashValue(journey),
    journeyKey: productJourneyKey(journey, "T001"),
    expectation: { basis: "agent-proposed" as const, outcomes: [] as string[] },
    status: "timed-out",
    failure: { kind: "behavior", message: "Promised result did not occur" },
    captures: [],
    operations: [
      {
        id: "failed-observation",
        kind: "observe",
        completedAt: "now",
        measurement: {
          json: JSON.stringify({ matched: false, expected: { text: "2" }, actual: { text: "1" } }),
          truncated: false,
        },
      },
    ],
  };
}

it("VISP-launched reviewer receives original exploratory failure and retirement after edits", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  const loaded = await readProductRecord(state, { feature: brief.feature });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const run = failure(brief, "old-source");
  value(
    await saveProductState(state, loaded.value, {
      ...loaded.value.state,
      captureRuns: [run],
      journeyRetirements: [
        {
          runId: run.id,
          journeyDigest: run.journeyDigest,
          task: "T001",
          createdAt: "now",
          reason: "Worker says this was speculative",
          provenance: "worker-reported" as const,
        },
      ],
    }),
  );
  const handoff = await runProductReviewerHandoff(state, { feature: brief.feature, task: "T001" });
  if (!handoff.ok) throw new Error(handoff.error.message);
  expect(handoff.value.experiments.exploratory).toHaveLength(1);
  const context = independentReviewerContext(handoff.value);
  expect(context).toHaveProperty(
    "experiments.exploratory.0.retirement.reason",
    "Worker says this was speculative",
  );
  const selected = value(await criticSelection(state, { feature: brief.feature, task: "T001" }));
  const critic = criticStateSchema.parse({
    version: 1,
    root: hashValue(workspace.root),
    feature: brief.feature,
    task: "T001",
    contract: selected.contract,
    intent: selected.intent,
    config: balancedCritic("codex"),
    disabled: false,
    attempts: [],
  });
  const packet = value(await criticPacket(state, selected, critic, handoff.value));
  expect(packet.current.experiments.exploratory[0]).toMatchObject({
    runId: run.id,
    status: "timed-out",
    message: "Promised result did not occur",
    retirement: { reason: "Worker says this was speculative", provenance: "worker-reported" },
  });
  expect(JSON.stringify(packet.responseSchema)).toContain('"HIST-failed"');
  expect(JSON.stringify(packet.responseSchema)).toContain('"failed-observation"');
});

it("reviewer can retain historical exploratory failure by its original negative evidence", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  const loaded = await readProductRecord(state, { feature: brief.feature });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const record = {
    ...loaded.value,
    state: { ...loaded.value.state, captureRuns: [failure(brief, "old-source")] },
  };
  const subject = await productSourceDigest(state, brief);
  if (!subject.ok) throw new Error(subject.error.message);
  expect(
    experimentReviewContext(record, subject.value, brief.slices[0]).exploratory[0]?.evidence,
  ).toContain("failed-observation");
  const catalogue = await productEvidenceCatalogue(
    state,
    record,
    subject.value,
    [],
    [],
    [],
    brief.slices[0],
  );
  expect(catalogue.entries.find((e) => e.id === "failed-observation")?.status).toBe("stale");
  const result = validateProductFeedback(
    {
      phase: "product",
      dimensions: [],
      resolutions: [],
      findings: [
        {
          dimension: "functional",
          problem: "Real contract defect",
          nextCheck: "Replay original input",
          outcomes: ["O001"],
          required: true,
          evidence: ["failed-observation"],
        },
      ],
    },
    record,
    catalogue,
    { context: "fresh" },
    brief.slices[0],
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      findings: [expect.objectContaining({ evidence: ["failed-observation", "HIST-failed"] })],
    },
  });
});

it("supported MCP transport retry preserves outcome ownership", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  runner.run.mockRejectedValueOnce(
    new BrowserUnavailableError("Chrome exited before becoming ready"),
  );
  const result = await runProductCapture(await workspace.state(), {
    feature: brief.feature,
    task: "T001",
    journey: { url: "http://localhost:3000/" },
    outcomes: ["O001"],
  });
  if (result.ok) throw new Error("Expected browser startup failure");
  if (!result.error.details?.supportedHostOption) throw new Error("Missing recovery option");
  const fallback = (
    result.error.details.supportedHostOption as {
      arguments: Parameters<typeof runProductCapture>[1];
    }
  ).arguments;
  runner.run.mockResolvedValueOnce({
    status: "timed-out",
    captures: [],
    operations: [],
    failure: { kind: "behavior", message: "Promised result failed" },
  });
  const retried = await runProductCapture(await workspace.state(), fallback);
  if (!retried.ok) throw new Error(retried.error.message);
  const loaded = await readProductRecord(await workspace.state(), { feature: brief.feature });
  if (!loaded.ok) throw new Error(loaded.error.message);
  expect(retried.value.expectation?.outcomes).toEqual(["O001"]);
  expect(pendingJourneyReplays(loaded.value, "edited", "T001").map((run) => run.id)).toEqual([
    retried.value.runId,
  ]);
  expect(result).toMatchObject({
    ok: false,
    error: { details: { supportedHostOption: { arguments: { outcomes: ["O001"] } } } },
  });
});

it("explicit unlinked failures remain informational", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-audit",
    originalRequest: "Observe the value",
    goal: "Observe",
    slices: [{ id: "T001", goal: "Observe", scope: { allowed: ["index.html"] } }],
  });
  const record = {
    brief,
    briefText: "",
    stateText: "",
    state: { ...initialProductState(brief, "now"), captureRuns: [failure(brief, "old")] },
  };
  expect(currentFailedJourneys(record, "old", "T001")).toEqual([]);
  expect(pendingJourneyReplays(record, "new", "T001")).toEqual([]);
});

it("reviewer history remains bounded and reports omitted records", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-audit",
    originalRequest: "Observe the value",
    goal: "Observe",
    slices: [{ id: "T001", goal: "Observe", scope: { allowed: ["index.html"] } }],
  });
  const runs = Array.from({ length: 100 }, (_, i) => failure(brief, "old", `failed-${i}`));
  const record = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "now"),
      captureRuns: runs,
      journeyRetirements: runs.map((run) => ({
        runId: run.id,
        journeyDigest: run.journeyDigest,
        task: run.task,
        reason: "Speculative",
        provenance: "worker-reported" as const,
        createdAt: "now",
      })),
    },
  };
  const context = experimentReviewContext(record, "new", brief.slices[0]);
  expect(context.exploratory).toHaveLength(1);
  expect(context.exploratory[0]?.runId).toBe("failed-99");
  expect(context.exploratoryOmitted).toBe(99);
  expect(context.retirements).toHaveLength(1);
  expect(context.retirements[0]?.runId).toBe("failed-99");
  expect(context.retirementsOmitted).toBe(99);
  expect(context.originalRecords).toContain("product-state.json");
});

it("retains the original retired journey through a validated production review submission", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  const loaded = value(await readProductRecord(state));
  const run = failure(brief, "old-source");
  value(
    await saveProductState(state, loaded, {
      ...loaded.state,
      captureRuns: [run],
      journeyRetirements: [
        {
          runId: run.id,
          journeyDigest: run.journeyDigest,
          task: "T001",
          reason: "Speculative",
          createdAt: "now",
          provenance: "worker-reported" as const,
        },
      ],
    }),
  );
  const bundle = value(await runProductReview(state));
  const feedback = {
    phase: "product",
    dimensions: [],
    resolutions: [],
    findings: [
      {
        dimension: "functional",
        problem: "Real contract defect",
        nextCheck: "Replay original input",
        outcomes: ["O001"],
        required: true,
        evidence: ["HIST-failed"],
      },
    ],
  };
  value(
    await runProductReview(state, {
      subjectDigest: bundle.subjectDigest,
      selection: bundle.selection,
      assessments: [],
      reviewer: { context: "fresh" },
      feedback,
    }),
  );
  const retained = value(await readProductRecord(state));
  expect(
    pendingJourneyReplays(retained, bundle.subjectDigest, "T001").map((entry) => entry.id),
  ).toEqual([run.id]);
  expect(retained.state.captureRuns[0]).toEqual(run);
  const finding = openRequiredFindings(retained, brief.slices[0])[0];
  if (!finding) throw new Error("Missing retained finding");
  expect(repairRecheck(retained, finding, bundle.subjectDigest, "T001")).toMatchObject({
    kind: "journey",
    before: { runId: run.id, subjectDigest: "old-source" },
  });

  const check = brief.checks[0];
  if (!check) throw new Error("Missing declared check");
  const unrelated: ProductRecord = {
    ...retained,
    state: {
      ...retained.state,
      executions: [
        {
          id: "unrelated-check",
          check: check.id,
          task: "T001",
          subjectDigest: bundle.subjectDigest,
          contractDigest: run.contractDigest,
          createdAt: "now",
          command: describeProductCheck(check),
          provenance: "supervisor-executed",
          assertions: "agent-reported",
          status: "passed",
          exitCode: 0,
          durationMs: 1,
          output: "Passed",
          verifierDigest: "a".repeat(64),
          comparisonEnvironment: "known",
        },
      ],
    },
  };
  const unrelatedCatalogue = await productEvidenceCatalogue(
    state,
    unrelated,
    bundle.subjectDigest,
    [],
    [],
    [],
    brief.slices[0],
  );
  const unrelatedResolution = value(
    validateProductFeedback(
      {
        phase: "product",
        dimensions: [],
        findings: [],
        resolutions: [
          {
            id: finding.id,
            disposition: "repaired",
            explanation: "The current check passes",
            evidence: ["unrelated-check"],
          },
        ],
      },
      unrelated,
      unrelatedCatalogue,
      { context: "fresh" },
      brief.slices[0],
    ),
  );
  expect(unrelatedResolution?.resolutions).toEqual([]);
  expect(
    pendingJourneyReplays(unrelated, bundle.subjectDigest, "T001").map((entry) => entry.id),
  ).toEqual([run.id]);
  const repaired: ProductRecord = {
    ...retained,
    state: {
      ...retained.state,
      captureRuns: [
        { ...run, comparisonEnvironment: "known" },
        {
          ...run,
          id: "repaired",
          subjectDigest: bundle.subjectDigest,
          status: "completed",
          failure: undefined,
          comparisonEnvironment: "known",
          operations: [
            {
              id: "passing-observation",
              kind: "observe",
              measurement: { json: '{"matched":true}', truncated: false },
            },
          ],
        },
      ],
    },
  };
  expect(findFunctionalRepair(repaired, finding, ["passing-observation"])).toMatchObject({
    reproductionId: run.id,
    recheckId: "repaired",
    subjectDigest: bundle.subjectDigest,
  });
  const catalogue = await productEvidenceCatalogue(
    state,
    retained,
    bundle.subjectDigest,
    [],
    [],
    [],
    brief.slices[0],
  );
  for (const invalid of [
    { ...feedback, findings: [{ ...feedback.findings[0], required: false }] },
    {
      ...feedback,
      findings: [],
      dimensions: [
        {
          dimension: "functional",
          status: "satisfied",
          reason: "Works",
          evidence: ["HIST-failed"],
        },
      ],
    },
    {
      ...feedback,
      findings: [],
      dimensions: [
        { dimension: "functional", status: "failed", reason: "Broken", evidence: ["HIST-failed"] },
      ],
    },
  ])
    expect(
      validateProductFeedback(invalid, retained, catalogue, { context: "fresh" }, brief.slices[0]),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  const assessment = await runProductReview(state, {
    subjectDigest: bundle.subjectDigest,
    assessments: [
      { outcome: "O001", status: "satisfied", summary: "Works", evidence: ["HIST-failed"] },
    ],
    reviewer: { context: "fresh" },
  });
  expect(assessment).toMatchObject({
    ok: true,
    value: { assessments: [expect.objectContaining({ status: "unavailable" })] },
  });
});

it("keeps newly added replay outcome links in transport recovery and persisted routing", async () => {
  const { workspace } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  runner.run.mockResolvedValueOnce({ status: "completed", captures: [], operations: [] });
  const original = value(
    await runProductCapture(state, { task: "T001", journey: { url: "http://localhost:3000/" } }),
  );
  runner.run.mockRejectedValueOnce(
    new BrowserUnavailableError("Chrome exited before becoming ready"),
  );
  const failed = await runProductCapture(state, { replay: original.runId, outcomes: ["O001"] });
  if (failed.ok) throw new Error("Expected browser startup failure");
  if (!failed.error.details?.supportedHostOption) throw new Error("Missing recovery option");
  const fallback = (
    failed.error.details.supportedHostOption as {
      arguments: Parameters<typeof runProductCapture>[1];
    }
  ).arguments;
  expect(fallback).toMatchObject({ replay: original.runId, outcomes: ["O001"] });
  expect(fallback).not.toHaveProperty("journey");
  runner.run.mockResolvedValueOnce({
    status: "timed-out",
    captures: [],
    operations: [],
    failure: { kind: "behavior", message: "Still broken" },
  });
  const retried = value(await runProductCapture(state, fallback));
  const record = value(await readProductRecord(state));
  expect(retried.expectation?.outcomes).toEqual(["O001"]);
  expect(pendingJourneyReplays(record, "edited", "T001").map((run) => run.id)).toEqual([
    retried.runId,
  ]);
});

it("bounds distinct histories, strings and references while preserving raw records", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-bounds",
    originalRequest: "Observe",
    goal: "Observe",
    slices: [{ id: "T001", goal: "Observe", scope: { allowed: ["index.html"] } }],
  });
  const runs = Array.from({ length: 20 }, (_, i) => {
    const run = failure(brief, "old", `failed-${i}`);
    run.journey = browserJourneySchema.parse({
      ...run.journey,
      actions: [{ kind: "wait-for", selector: `#result-${i}`, text: "2", timeoutMs: 100 }],
    });
    run.journeyDigest = hashValue(run.journey);
    run.journeyKey = productJourneyKey(run.journey, run.task);
    run.failure.message = "x".repeat(10000);
    const operation = run.operations[0];
    if (!operation) throw new Error("Missing failed observation");
    run.operations = Array.from({ length: 30 }, (_, n) => ({
      ...operation,
      id: `op-${i}-${n}`,
    }));
    return run;
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: {
      ...initialProductState(brief, "now"),
      captureRuns: runs,
      journeyRetirements: runs.map((run) => ({
        runId: run.id,
        journeyDigest: run.journeyDigest,
        task: run.task,
        reason: "r".repeat(500),
        provenance: "worker-reported" as const,
        createdAt: "now",
      })),
    },
  };
  const before = structuredClone(record);
  const context = experimentReviewContext(record, "new", brief.slices[0]);
  expect(context.exploratory).toHaveLength(6);
  expect(context.exploratoryOmitted).toBe(14);
  expect(context.retirements).toHaveLength(6);
  expect(context.retirementsOmitted).toBe(14);
  for (const entry of context.exploratory) {
    expect(entry.message?.length).toBeLessThanOrEqual(600);
    expect(entry.messageCharactersOmitted).toBe(9400);
    expect(entry.evidence.length).toBeLessThanOrEqual(3);
    expect(entry.evidenceOmitted).toBe(28);
    expect(entry.retirement?.reason.length).toBeLessThanOrEqual(240);
    expect(entry.retirement?.reasonCharactersOmitted).toBe(260);
  }
  expect(JSON.stringify(context).length).toBeLessThan(18000);
  expect(record).toEqual(before);
});

it("indexes retained journey ownership once instead of hashing history for each candidate", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-index",
    originalRequest: "Observe",
    goal: "Observe",
    slices: [{ id: "T001", goal: "Observe", scope: { allowed: ["index.html"] } }],
  });
  const runs = Array.from({ length: 100 }, (_, i) => failure(brief, "old", `failed-${i}`));
  const first = runs[0];
  if (!first) throw new Error("Missing original run");
  first.expectation.outcomes = ["O001"];
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: { ...initialProductState(brief, "now"), captureRuns: runs },
  };
  const hashes = vi.spyOn(hashing, "hashValue");
  const index = journeyOwnershipIndex(record);
  for (const run of runs) expect(index.isExploratory(run)).toBe(false);
  expect(hashes.mock.calls.length).toBeLessThanOrEqual(runs.length * 4);
});

it("rejects historical retention when the original journey is corrupt, duplicated or out of scope", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  const loaded = value(await readProductRecord(state));
  const run = failure(brief, "old");
  const record: ProductRecord = { ...loaded, state: { ...loaded.state, captureRuns: [run] } };
  const catalogue = await productEvidenceCatalogue(
    state,
    record,
    "new",
    [],
    [],
    [],
    brief.slices[0],
  );
  const feedback = {
    phase: "product",
    dimensions: [],
    resolutions: [],
    findings: [
      {
        dimension: "functional",
        problem: "Broken",
        nextCheck: "Replay",
        required: true,
        outcomes: ["O001"],
        evidence: ["HIST-failed"],
      },
    ],
  };
  for (const captureRuns of [
    [{ ...run, journeyDigest: "corrupt" }],
    [run, run],
    [{ ...run, task: "T002" }],
  ]) {
    const changed: ProductRecord = { ...record, state: { ...record.state, captureRuns } };
    expect(
      validateProductFeedback(feedback, changed, catalogue, { context: "fresh" }, brief.slices[0]),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
  }
});
