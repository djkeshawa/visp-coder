import { describe, expect, it } from "vitest";
import { hashValue } from "../../../src/core/hash.js";
import type {
  Confirmation,
  Preregistration,
  StudyObservation,
} from "../../../src/runner/evaluation.js";
import { assignPilot, decideEscalation, summarizeStudy } from "../../../src/runner/evaluation.js";

describe("measured runner evaluation", () => {
  it("assigns all 72 host/scenario/arm cells deterministically without leaking learning data", () => {
    const scenarios = ["typescript", "python", "ui"].flatMap((cohort) =>
      Array.from({ length: 4 }, (_, n) => ({
        id: `${cohort}-${n}`,
        cohort,
        repositoryGroup: `${cohort}-repo`,
        split: "pilot" as const,
      })),
    );
    const assigned = assignPilot("study", "seed", scenarios);
    expect(assigned).toHaveLength(72);
    expect(assigned).toEqual(assignPilot("study", "seed", scenarios));
    expect(new Set(assigned.map((row) => `${row.scenario}/${row.host}/${row.arm}`)).size).toBe(72);
    expect(() =>
      assignPilot("study", "seed", [
        { id: "one", cohort: "typescript", repositoryGroup: "repo", split: "learning" },
      ]),
    ).toThrow(/pilot|cohort/i);
  });

  it("retains expensive failures and refuses promotion without confirmed clustered evidence", () => {
    const result = summarizeStudy([
      {
        runId: "a",
        arm: "economical-visp",
        repositoryGroup: "r",
        scenario: "one",
        accepted: true,
        host: "codex",
        repetition: 0,
        split: "pilot",
        status: "accepted",
        receiptHash: null,
        severeDefects: 0,
        modelUsd: 1,
        executionUsd: 0.2,
        reviewMinutes: 3,
        reviewerHourlyUsd: 60,
        durationMs: 200,
      },
      {
        runId: "b",
        arm: "economical-visp",
        repositoryGroup: "r",
        scenario: "two",
        accepted: false,
        host: "codex",
        repetition: 0,
        split: "pilot",
        status: "failed",
        receiptHash: null,
        severeDefects: 0,
        modelUsd: 8,
        executionUsd: 0.3,
        reviewMinutes: 1,
        reviewerHourlyUsd: 60,
        durationMs: 400,
      },
    ]);
    expect(result.arms[0]).toMatchObject({
      attempts: 2,
      accepted: 1,
      totalUsd: 13.5,
      costPerAcceptedTaskUsd: 13.5,
    });
    expect(result.promotion).toMatchObject({ eligible: false });
  });

  it("keeps unknown costs unknown and does not automatically escalate on infrastructure faults", () => {
    expect(
      summarizeStudy([
        {
          runId: "a",
          arm: "economical-visp",
          repositoryGroup: "r",
          scenario: "s",
          accepted: false,
          host: "codex",
          repetition: 0,
          split: "pilot",
          status: "failed",
          receiptHash: null,
          severeDefects: 0,
          modelUsd: null,
          executionUsd: 0,
          reviewMinutes: 0,
          reviewerHourlyUsd: 60,
          durationMs: 1,
        },
      ]).arms[0]?.totalUsd,
    ).toBeNull();
    const budget = {
      remainingUsd: 5,
      remainingMs: 1000,
      attempts: 1,
      maxAttempts: 2,
      escalationEstimatedUsd: 2,
      escalationMinimumMs: 500,
    };
    expect(
      decideEscalation({ ...budget, failure: "infrastructure", evidenceIds: ["e1"] }).action,
    ).toBe("repair-environment");
    expect(decideEscalation({ ...budget, failure: "verification", evidenceIds: [] }).action).toBe(
      "request-evidence",
    );
    expect(
      decideEscalation({ ...budget, failure: "verification", evidenceIds: ["e1"] }).action,
    ).toBe("escalate");
  });

  it("binds matched confirmation cells but never promotes on a supplied confidence scalar", () => {
    const rows: StudyObservation[] = ["r1", "r2"].flatMap((repositoryGroup) =>
      ["economical-baseline", "economical-visp"].map((arm) => ({
        runId: `${repositoryGroup}-${arm}`,
        arm,
        repositoryGroup,
        scenario: "one",
        host: "codex" as const,
        repetition: 0,
        split: "confirmation" as const,
        status: "accepted" as const,
        accepted: true,
        receiptHash: "a".repeat(64),
        severeDefects: 0,
        modelUsd: arm === "economical-visp" ? 1 : 2,
        executionUsd: 0,
        reviewMinutes: 0,
        reviewerHourlyUsd: 60,
        durationMs: 100,
      })),
    );
    const preregistration: Preregistration = {
      schemaVersion: 1,
      study: "confirm",
      frozenAt: "2026-09-05T00:00:00Z",
      analysisPlanHash: "b".repeat(64),
      referenceArm: "economical-baseline",
      treatmentArm: "economical-visp",
      learningRepositories: [],
      pilotRepositories: [],
      assignments: rows.map((row, order) => ({
        runId: row.runId,
        study: "confirm",
        scenario: row.scenario,
        repositoryGroup: row.repositoryGroup,
        host: row.host,
        arm: row.arm as "economical-visp" | "economical-baseline",
        split: "confirmation",
        repetition: 0,
        order,
      })),
    };
    const confirmation: Confirmation = {
      schemaVersion: 1,
      study: "confirm",
      preregistration,
      preregistrationHash: hashValue(preregistration),
      observationHash: hashValue(rows),
      analysis: "preregistered-repository-clustered",
      analysisReportHash: "c".repeat(64),
      acceptanceDifferenceLower95: { codex: 0 },
      adjudication: "independent-reviewed",
    };
    expect(summarizeStudy(rows, confirmation).promotion).toMatchObject({
      eligible: false,
      reportedTargetsMet: true,
    });
    const pilot = rows.map((row) => ({ ...row, split: "pilot" as const }));
    expect(
      summarizeStudy(pilot, { ...confirmation, observationHash: hashValue(pilot) }).promotion,
    ).toMatchObject({ eligible: false, reportedTargetsMet: false });
    const missing = rows.slice(1);
    expect(
      summarizeStudy(missing, { ...confirmation, observationHash: hashValue(missing) }).promotion
        .reason,
    ).toMatch(/incomplete/i);
  });
});
