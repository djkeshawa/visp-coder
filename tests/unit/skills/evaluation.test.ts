import { afterEach, describe, expect, it } from "vitest";
import { hashValue } from "../../../src/core/hash.js";
import {
  checkSkillEvaluation,
  promoteSkill,
  readSkillEvaluation,
  recordSkillEvaluation,
  type SkillEvaluationInput,
} from "../../../src/skills/evaluation.js";
import { transitionSkill } from "../../../src/skills/lifecycle.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { rollbackSkill } from "../../../src/skills/rollback.js";
import { TestWorkspace } from "../support/workspace.js";

function input(version = "a".repeat(64)): SkillEvaluationInput {
  const pairs = [0, 1, 2].map((id) => ({
    scenario: `scenario-${id}`,
    repositoryGroup: `heldout-${id}`,
    on: {
      runId: `on-${id}`,
      receiptHash: hashValue(["on", id]),
      accepted: true,
      severeDefects: 0,
      totalUsd: 1,
    },
    off: {
      runId: `off-${id}`,
      receiptHash: hashValue(["off", id]),
      accepted: true,
      severeDefects: 0,
      totalUsd: 2,
    },
  }));
  const preregistration = {
    schemaVersion: 1 as const,
    study: "fixture-study",
    frozenAt: "2026-09-01T00:00:00.000Z",
    skillVersion: version,
    model: "fixture-model",
    taskClass: "feature" as const,
    learningRepositoryGroups: ["learning-repo"],
    pilotRepositoryGroups: ["pilot-repo"],
    analysisPlanHash: "d".repeat(64),
    assignments: pairs.map((pair) => ({
      scenario: pair.scenario,
      repositoryGroup: pair.repositoryGroup,
      onRunId: pair.on.runId,
      offRunId: pair.off.runId,
    })),
  };
  return {
    schemaVersion: 1,
    skillVersion: version,
    model: "fixture-model",
    taskClass: "feature",
    learningRepositoryGroups: ["learning-repo"],
    split: "confirmation",
    pairs,
    confirmation: {
      preregistration,
      preregistrationHash: hashValue(preregistration),
      analysisHash: "e".repeat(64),
      observationHash: hashValue(pairs),
      acceptanceDeltaLower95: -0.01,
    },
    decision: "beneficial",
    rationale: "Fixture only: supplied analysis satisfies the declared thresholds",
  };
}

describe("reviewed skill evaluation", () => {
  it("keeps descriptive metrics distinct from supplied statistical analysis", () => {
    const result = checkSkillEvaluation(input());
    expect(result.ok && result.value.metrics).toMatchObject({
      acceptanceDelta: 0,
      costReduction: 0.5,
      onCostPerAccepted: 1,
    });
  });
  it("rejects pilot promotion and unresolved reliability", () => {
    expect(checkSkillEvaluation({ ...input(), split: "pilot" }).ok).toBe(false);
    const value = input();
    expect(
      checkSkillEvaluation({
        ...value,
        confirmation: { ...value.confirmation, acceptanceDeltaLower95: -0.2 },
      }).ok,
    ).toBe(false);
  });
  it("keeps learning repositories out of held-out evidence", () => {
    expect(checkSkillEvaluation({ ...input(), learningRepositoryGroups: ["heldout-0"] }).ok).toBe(
      false,
    );
  });
  it("rejects recycled scenarios and run identifiers", () => {
    const value = input();
    expect(checkSkillEvaluation({ ...value, pairs: [value.pairs[0], value.pairs[0]] }).ok).toBe(
      false,
    );
    const pairs = value.pairs.map((pair) => ({
      ...pair,
      off: { ...pair.off, runId: pair.on.runId },
    }));
    expect(checkSkillEvaluation({ ...value, pairs }).ok).toBe(false);
  });
  it("rejects reused receipt identities and mislabeled or missing planned assignments", () => {
    const value = input();
    const shared = value.pairs[0]?.on.receiptHash;
    const pairs = value.pairs.map((pair) => ({
      ...pair,
      on: { ...pair.on, receiptHash: shared },
    }));
    expect(checkSkillEvaluation({ ...value, pairs }).ok).toBe(false);
    expect(checkSkillEvaluation({ ...value, model: "different-model" }).ok).toBe(false);
    const fewer = value.pairs.slice(1);
    expect(
      checkSkillEvaluation({
        ...value,
        pairs: fewer,
        confirmation: { ...value.confirmation, observationHash: hashValue(fewer) },
      }).ok,
    ).toBe(false);
  });
  it("rejects incomplete costs without dropping expensive failures", () => {
    const value = input();
    const pairs = value.pairs.map((pair, position) =>
      position === 0 ? { ...pair, on: { ...pair.on, totalUsd: null } } : pair,
    );
    expect(
      checkSkillEvaluation({
        ...value,
        pairs,
        confirmation: { ...value.confirmation, observationHash: hashValue(pairs) },
      }).ok,
    ).toBe(false);
    const inconclusive = checkSkillEvaluation({
      ...value,
      pairs,
      decision: "inconclusive",
      confirmation: undefined,
    });
    expect(inconclusive.ok && inconclusive.value.metrics.costReduction).toBeNull();
  });
  it("rejects stale analysis hashes and severe defects even when a control also failed", () => {
    const value = input();
    const pairs = value.pairs.map((pair) => ({
      ...pair,
      on: { ...pair.on, severeDefects: 1 },
      off: { ...pair.off, severeDefects: 2 },
    }));
    expect(checkSkillEvaluation({ ...value, pairs }).ok).toBe(false);
    expect(
      checkSkillEvaluation({
        ...value,
        pairs,
        confirmation: { ...value.confirmation, observationHash: hashValue(pairs) },
      }).ok,
    ).toBe(false);
  });
});

describe("evaluation persistence and activation", () => {
  let workspace: TestWorkspace | undefined;
  afterEach(async () => {
    await workspace?.destroy();
  });
  async function fixture(content = "## Procedure\nCheck results.\n") {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    const proposal = await createProposalFromContent(
      state,
      { id: "measured-check", origin: "seeded" },
      content,
    );
    if (!proposal.ok) throw new Error(proposal.error.message);
    return { state, candidate: proposal.value };
  }
  it("records immutable operator-supplied evidence before explicit promotion", async () => {
    const { state, candidate } = await fixture();
    const recorded = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify(input(candidate.version)),
      "reviewer",
    );
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect(recorded.value.skill.state).toBe("proposed");
    expect(recorded.value.evaluation.provenance).toBe("operator-supplied-analysis");
    expect(recorded.value.skill.evidence).toMatchObject({
      usefulness: "beneficial",
      usefulnessBasis: "operator-reviewed-claim",
    });
    expect((await readSkillEvaluation(state, candidate.id, recorded.value.id)).ok).toBe(true);
    const promoted = await promoteSkill(state, candidate.id, recorded.value.id, "reviewer");
    expect(promoted.ok && promoted.value.state).toBe("admitted");
    expect(promoted.ok && promoted.value.evidence?.verification.execution).toBe("not-run");
  });
  it("refuses mismatched revisions and inconclusive promotion", async () => {
    const { state, candidate } = await fixture();
    expect(
      (await recordSkillEvaluation(state, candidate.id, JSON.stringify(input()), "reviewer")).ok,
    ).toBe(false);
    const value = {
      ...input(candidate.version),
      decision: "inconclusive",
      split: "pilot",
      confirmation: undefined,
    };
    const recorded = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify(value),
      "reviewer",
    );
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect((await promoteSkill(state, candidate.id, recorded.value.id, "reviewer")).ok).toBe(false);
  });
  it("refuses evaluations outside a revision's declared task class", async () => {
    const { state, candidate } = await fixture(
      "---\nappliesTo:\n  taskClass: bugfix\n---\n## Procedure\nCheck results.\n",
    );
    const result = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify(input(candidate.version)),
      "reviewer",
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("task class");
  });
  it("does not promote an older favorable claim after a newer inconclusive evaluation", async () => {
    const { state, candidate } = await fixture();
    const favorable = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify(input(candidate.version)),
      "reviewer",
    );
    if (!favorable.ok) throw new Error(favorable.error.message);
    const later = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify({
        ...input(candidate.version),
        decision: "inconclusive",
        split: "pilot",
        confirmation: undefined,
      }),
      "reviewer",
    );
    expect(later.ok).toBe(true);
    expect((await promoteSkill(state, candidate.id, favorable.value.id, "reviewer")).ok).toBe(
      false,
    );
  });
  it("retires harmful reviewed guidance and refuses to revive that revision", async () => {
    const { state, candidate } = await fixture();
    await transitionSkill(state, candidate.id, "admitted", { by: "reviewer" });
    const value = {
      ...input(candidate.version),
      decision: "harmful",
      split: "pilot",
      confirmation: undefined,
    };
    const recorded = await recordSkillEvaluation(
      state,
      candidate.id,
      JSON.stringify(value),
      "reviewer",
    );
    expect(recorded.ok && recorded.value.skill.state).toBe("retired");
    expect(
      (
        await rollbackSkill(state, candidate.id, candidate.version ?? "", {
          by: "reviewer",
          reason: "Attempt stale rollback",
        })
      ).ok,
    ).toBe(false);
  });
});
