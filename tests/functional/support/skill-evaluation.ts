import { hashValue } from "../../../src/core/hash.js";
import type { SkillEvaluationInput } from "../../../src/skills/evaluation.js";

/** Synthetic operator claims exercise storage/activation, not empirical model benefit. */
export function syntheticSkillEvaluation(skillVersion: string): SkillEvaluationInput {
  const pairs = [1, 2].map((id) => ({
    scenario: `fixture-${id}`,
    repositoryGroup: `heldout-${id}`,
    on: {
      runId: `on-${id}`,
      receiptHash: hashValue([id, "on"]),
      accepted: true,
      severeDefects: 0,
      totalUsd: 1,
    },
    off: {
      runId: `off-${id}`,
      receiptHash: hashValue([id, "off"]),
      accepted: true,
      severeDefects: 0,
      totalUsd: 2,
    },
  }));
  const preregistration = {
    schemaVersion: 1 as const,
    study: "synthetic-cli-study",
    frozenAt: "2026-09-01T00:00:00.000Z",
    skillVersion,
    model: "fixture-model",
    taskClass: "feature" as const,
    learningRepositoryGroups: ["learning"],
    pilotRepositoryGroups: ["pilot"],
    analysisPlanHash: hashValue("fixture-analysis-plan"),
    assignments: pairs.map((pair) => ({
      scenario: pair.scenario,
      repositoryGroup: pair.repositoryGroup,
      onRunId: pair.on.runId,
      offRunId: pair.off.runId,
    })),
  };
  return {
    schemaVersion: 1,
    skillVersion,
    model: preregistration.model,
    taskClass: "feature",
    learningRepositoryGroups: ["learning"],
    split: "confirmation",
    pairs,
    confirmation: {
      preregistration,
      preregistrationHash: hashValue(preregistration),
      analysisHash: hashValue("synthetic-analysis"),
      observationHash: hashValue(pairs),
      acceptanceDeltaLower95: -0.01,
    },
    decision: "beneficial",
    rationale:
      "Synthetic fixture satisfies supplied analysis thresholds; no real model runs occurred",
  };
}
