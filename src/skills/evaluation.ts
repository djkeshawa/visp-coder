import { join } from "node:path";
import { z } from "zod";
import { TASK_CLASSES } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { withStateMutation } from "../core/file-transaction.js";
import { hashValue, sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";
import { isoTimestampSchema, now, sha256Schema } from "../workflow/artifacts/common.js";
import type { WorkspaceState } from "../workflow/state.js";
import { findSkill, transitionSkill } from "./lifecycle.js";
import { type SkillRecord, validateSkillId } from "./schema.js";
import { persistSkillRecord } from "./store.js";
import { readSkillRevision } from "./versions.js";

const armSchema = z
  .object({
    runId: z.string().min(1),
    receiptHash: sha256Schema,
    accepted: z.boolean(),
    severeDefects: z.number().int().nonnegative(),
    /** Model, execution and review costs combined; null means unknown, never free. */
    totalUsd: z.number().finite().nonnegative().nullable(),
  })
  .strict();
const pairSchema = z
  .object({
    scenario: z.string().min(1),
    repositoryGroup: z.string().min(1),
    on: armSchema,
    off: armSchema,
  })
  .strict();

export const skillPreregistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    study: z.string().min(1),
    frozenAt: isoTimestampSchema,
    skillVersion: sha256Schema,
    model: z.string().min(1),
    taskClass: z.enum(TASK_CLASSES),
    learningRepositoryGroups: z.array(z.string().min(1)).min(1),
    pilotRepositoryGroups: z.array(z.string().min(1)),
    analysisPlanHash: sha256Schema,
    assignments: z
      .array(
        z
          .object({
            scenario: z.string().min(1),
            repositoryGroup: z.string().min(1),
            onRunId: z.string().min(1),
            offRunId: z.string().min(1),
          })
          .strict(),
      )
      .min(2)
      .max(20_000),
  })
  .strict();
export type SkillPreregistration = z.infer<typeof skillPreregistrationSchema>;

export const skillEvaluationInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    skillVersion: sha256Schema,
    model: z.string().min(1),
    taskClass: z.enum(TASK_CLASSES),
    learningRepositoryGroups: z.array(z.string().min(1)).min(1),
    split: z.enum(["pilot", "confirmation"]),
    pairs: z.array(pairSchema).min(2).max(20_000),
    /** Operator-supplied analysis; hashes bind claims without authenticating their producer. */
    confirmation: z
      .object({
        preregistrationHash: sha256Schema,
        preregistration: skillPreregistrationSchema,
        analysisHash: sha256Schema,
        observationHash: sha256Schema,
        acceptanceDeltaLower95: z.number().min(-1).max(1),
      })
      .strict()
      .optional(),
    decision: z.enum(["beneficial", "inconclusive", "harmful"]),
    rationale: z.string().min(1),
  })
  .strict();
export type SkillEvaluationInput = z.infer<typeof skillEvaluationInputSchema>;

const metricsSchema = z
  .object({
    pairs: z.number().int().nonnegative(),
    acceptanceDelta: z.number(),
    onCostPerAccepted: z.number().nullable(),
    offCostPerAccepted: z.number().nullable(),
    costReduction: z.number().nullable(),
    severeRegressions: z.number().int().nonnegative(),
  })
  .strict();
export type SkillEvaluationMetrics = z.infer<typeof metricsSchema>;

const evaluationSchema = z
  .object({
    kind: z.literal("skill-evaluation"),
    schemaVersion: z.literal(1),
    createdAt: isoTimestampSchema,
    skill: z.string().min(1),
    input: skillEvaluationInputSchema,
    metrics: metricsSchema,
    sourceHash: sha256Schema,
    reviewedBy: z.string().min(1),
    provenance: z.literal("operator-supplied-analysis"),
  })
  .strict();
export type SkillEvaluation = z.infer<typeof evaluationSchema>;

export function checkSkillEvaluation(
  raw: unknown,
): Result<{ input: SkillEvaluationInput; metrics: SkillEvaluationMetrics }> {
  const parsed = skillEvaluationInputSchema.safeParse(raw);
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Invalid skill evaluation: ${parsed.error.message}`));
  const input = parsed.data;
  const pairs = validatePairs(input);
  if (!pairs.ok) return pairs;
  const metrics = evaluationMetrics(input);
  const bound = validateConfirmation(input);
  if (!bound.ok) return bound;
  const promotion = validateBenefit(input, metrics);
  if (!promotion.ok) return promotion;
  return ok({ input, metrics });
}

function validatePairs(input: SkillEvaluationInput): Result<void> {
  const seenScenarios = new Set<string>();
  const seenRuns = new Set<string>();
  const seenReceipts = new Set<string>();
  const learning = new Set(input.learningRepositoryGroups);
  for (const pair of input.pairs) {
    const scenario = JSON.stringify([pair.repositoryGroup, pair.scenario]);
    if (learning.has(pair.repositoryGroup))
      return err(
        vispError("ARTIFACT_INVALID", "Evaluation repositories overlap the learning repositories"),
      );
    if (seenScenarios.has(scenario))
      return err(
        vispError(
          "ARTIFACT_INVALID",
          "Repeated attempts must not count as independent evaluation scenarios",
        ),
      );
    seenScenarios.add(scenario);
    for (const arm of [pair.on, pair.off]) {
      if (seenRuns.has(arm.runId) || seenReceipts.has(arm.receiptHash))
        return err(
          vispError(
            "ARTIFACT_INVALID",
            "A run or receipt cannot be reused across skill evaluation arms",
          ),
        );
      seenRuns.add(arm.runId);
      seenReceipts.add(arm.receiptHash);
    }
  }
  return ok(undefined);
}

function validateConfirmation(input: SkillEvaluationInput): Result<void> {
  const confirmation = input.confirmation;
  if (!confirmation) return ok(undefined);
  const planned = confirmation.preregistration;
  if (
    confirmation.preregistrationHash !== hashValue(planned) ||
    confirmation.observationHash !== hashValue(input.pairs)
  )
    return err(
      vispError("ARTIFACT_INVALID", "Confirmation claims do not match their content hashes"),
    );
  const actual = input.pairs.map((pair) => ({
    scenario: pair.scenario,
    repositoryGroup: pair.repositoryGroup,
    onRunId: pair.on.runId,
    offRunId: pair.off.runId,
  }));
  if (
    planned.skillVersion !== input.skillVersion ||
    planned.model !== input.model ||
    planned.taskClass !== input.taskClass ||
    hashValue([...planned.learningRepositoryGroups].sort()) !==
      hashValue([...input.learningRepositoryGroups].sort()) ||
    hashValue(planned.assignments.map(hashValue).sort()) !== hashValue(actual.map(hashValue).sort())
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Evaluation labels or runs differ from preregistered assignments",
      ),
    );
  if (input.pairs.some((pair) => planned.pilotRepositoryGroups.includes(pair.repositoryGroup)))
    return err(vispError("ARTIFACT_INVALID", "Confirmatory tasks overlap the pilot repositories"));
  return ok(undefined);
}

function validateBenefit(
  input: SkillEvaluationInput,
  metrics: SkillEvaluationMetrics,
): Result<void> {
  if (input.decision === "beneficial") {
    if (input.split !== "confirmation" || !input.confirmation)
      return err(
        vispError(
          "UNSUPPORTED",
          "A pilot cannot establish a beneficial promotion; provide separate confirmatory analysis",
        ),
      );
    if (
      input.confirmation.acceptanceDeltaLower95 <= -0.02 ||
      input.confirmation.acceptanceDeltaLower95 > metrics.acceptanceDelta ||
      metrics.costReduction === null ||
      metrics.costReduction < 0.25 ||
      input.pairs.some((pair) => pair.on.severeDefects > 0)
    ) {
      return err(
        vispError(
          "UNSUPPORTED",
          "Beneficial promotion requires the declared reliability bound, at least 25% lower complete cost per accepted task, and no severe regression",
        ),
      );
    }
  }
  return ok(undefined);
}

function evaluationMetrics(input: SkillEvaluationInput): SkillEvaluationMetrics {
  const onAccepted = input.pairs.filter((pair) => pair.on.accepted).length;
  const offAccepted = input.pairs.filter((pair) => pair.off.accepted).length;
  const cost = (arm: "on" | "off", accepted: number) => {
    if (accepted === 0 || input.pairs.some((pair) => pair[arm].totalUsd === null)) return null;
    return input.pairs.reduce((sum, pair) => sum + (pair[arm].totalUsd ?? 0), 0) / accepted;
  };
  const onCostPerAccepted = cost("on", onAccepted);
  const offCostPerAccepted = cost("off", offAccepted);
  return {
    pairs: input.pairs.length,
    acceptanceDelta: (onAccepted - offAccepted) / input.pairs.length,
    onCostPerAccepted,
    offCostPerAccepted,
    costReduction:
      onCostPerAccepted === null || offCostPerAccepted === null || offCostPerAccepted === 0
        ? null
        : 1 - onCostPerAccepted / offCostPerAccepted,
    severeRegressions: input.pairs.filter((pair) => pair.on.severeDefects > pair.off.severeDefects)
      .length,
  };
}

export async function recordSkillEvaluation(
  state: WorkspaceState,
  id: string,
  source: string,
  reviewedBy: string,
): Promise<Result<{ id: string; evaluation: SkillEvaluation; skill: SkillRecord }>> {
  if (!reviewedBy.trim())
    return err(vispError("UNSUPPORTED", "Evaluation review requires a named reviewer"));
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return err(vispError("ARTIFACT_INVALID", "Skill evaluation is not valid JSON"));
  }
  const checked = checkSkillEvaluation(raw);
  if (!checked.ok) return checked;
  return withStateMutation(state.paths.root, async () => {
    const found = await evaluationTarget(state, id, checked.value.input);
    if (!found.ok) return found;
    const evaluation: SkillEvaluation = {
      kind: "skill-evaluation",
      schemaVersion: 1,
      createdAt: now(),
      skill: id,
      ...checked.value,
      sourceHash: sha256(source),
      reviewedBy,
      provenance: "operator-supplied-analysis",
    };
    const evaluationId = hashValue(evaluation);
    const skill: SkillRecord = {
      ...found.value,
      evaluations: [...(found.value.evaluations ?? []), evaluationId],
      evidence: {
        ...(found.value.evidence ?? {
          verification: { execution: "unknown" as const },
          provenance: "unknown" as const,
        }),
        usefulness: evaluation.input.decision,
        usefulnessBasis: "operator-reviewed-claim",
      },
      ...(evaluation.input.decision === "harmful" && found.value.state === "admitted"
        ? {
            state: "retired" as const,
            reason: `Reviewed harmful evaluation ${evaluationId}: ${evaluation.input.rationale}`,
          }
        : {}),
    };
    const stored = await persistSkillRecord(state, skill, [
      {
        kind: "write",
        path: join(state.paths.state, "skills", id, "evaluations", `${evaluationId}.json`),
        content: `${JSON.stringify(evaluation, null, 2)}\n`,
        expectedBefore: { existed: false },
      },
    ]);
    return stored.ok ? ok({ id: evaluationId, evaluation, skill }) : stored;
  });
}

async function evaluationTarget(
  state: WorkspaceState,
  id: string,
  input: SkillEvaluationInput,
): Promise<Result<SkillRecord>> {
  const found = await findSkill(state, id);
  if (!found.ok) return found;
  if (found.value.version !== input.skillVersion)
    return err(vispError("ARTIFACT_INVALID", "Evaluation targets a different skill revision"));
  const classes = found.value.appliesTo?.taskClass ?? [];
  if (classes.length > 0 && !classes.includes(input.taskClass))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Evaluation task class does not match this skill's declared applicability",
      ),
    );
  const revision = await readSkillRevision(state, id, input.skillVersion);
  if (!revision.ok) return revision;
  if (!revision.value)
    return err(vispError("ARTIFACT_MISSING", "Evaluation requires an immutable skill revision"));
  return found;
}

export async function readSkillEvaluation(
  state: WorkspaceState,
  id: string,
  evaluationId: string,
): Promise<Result<SkillEvaluation>> {
  const valid = validateSkillId(id);
  if (!valid.ok) return valid;
  if (!sha256Schema.safeParse(evaluationId).success)
    return err(vispError("ARTIFACT_INVALID", "Evaluation id must be a full sha256 digest"));
  const stored = await state.files.readJsonIfExists(
    join(state.paths.state, "skills", id, "evaluations", `${evaluationId}.json`),
    (raw) => {
      const parsed = evaluationSchema.safeParse(raw);
      if (!parsed.success || hashValue(parsed.data) !== evaluationId || parsed.data.skill !== id)
        return err(vispError("ARTIFACT_INVALID", "Invalid or tampered skill evaluation"));
      return ok(parsed.data);
    },
  );
  if (!stored.ok) return stored;
  return stored.value
    ? ok(stored.value)
    : err(vispError("ARTIFACT_MISSING", "No such skill evaluation"));
}

/** Human activation against bound operator claims; no authenticated empirical benefit is implied. */
export async function promoteSkill(
  state: WorkspaceState,
  id: string,
  evaluationId: string,
  by: string,
): Promise<Result<SkillRecord>> {
  return withStateMutation(state.paths.root, async () => {
    const found = await findSkill(state, id);
    if (!found.ok) return found;
    const evaluation = await readSkillEvaluation(state, id, evaluationId);
    if (!evaluation.ok) return evaluation;
    const checked = checkSkillEvaluation(evaluation.value.input);
    if (!checked.ok) return checked;
    if (
      evaluation.value.input.decision !== "beneficial" ||
      evaluation.value.input.skillVersion !== found.value.version ||
      found.value.evaluations?.at(-1) !== evaluationId
    )
      return err(
        vispError(
          "UNSUPPORTED",
          "Promotion requires a recorded beneficial evaluation of this exact revision",
        ),
      );
    return transitionSkill(state, id, "admitted", {
      by,
      reason: `Human activation against operator-reviewed claim ${evaluationId}`,
    });
  });
}
