import { z } from "zod";
import { hashValue, sha256 } from "../core/hash.js";
import {
  type Assignment,
  assignmentSchema,
  type RunnerHost,
  runnerHostSchema,
} from "./contracts.js";

export interface PilotScenario {
  readonly id: string;
  readonly cohort: string;
  readonly repositoryGroup: string;
  readonly split: string;
}
export type PilotAssignment = Assignment & { readonly host: RunnerHost };

export function assignPilot(
  study: string,
  seed: string,
  scenarios: readonly PilotScenario[],
): PilotAssignment[] {
  if (!study || !seed) throw new Error("Study and randomization seed are required");
  for (const cohort of ["typescript", "python", "ui"]) {
    if (scenarios.filter((row) => row.cohort === cohort && row.split === "pilot").length !== 4) {
      throw new Error(`Pilot requires four held-out ${cohort} cohort scenarios`);
    }
  }
  if (scenarios.length !== 12 || new Set(scenarios.map((row) => row.id)).size !== 12)
    throw new Error("Pilot requires 12 distinct scenarios");
  const assignments = scenarios.flatMap((scenario) =>
    (["codex", "claude"] as const).flatMap((host) =>
      (["economical-baseline", "economical-visp", "strong-reference"] as const).map((arm) => ({
        study,
        scenario: scenario.id,
        repositoryGroup: scenario.repositoryGroup,
        host,
        arm,
        split: "pilot" as const,
        repetition: 0,
        order: 0,
      })),
    ),
  );
  return assignments
    .sort((a, b) =>
      sha256(`${seed}:${hashValue(a)}`).localeCompare(sha256(`${seed}:${hashValue(b)}`)),
    )
    .map((assignment, order) => ({ ...assignment, order }));
}

export const studyObservationSchema = z
  .object({
    runId: z.string().min(1),
    arm: z.string().min(1),
    repositoryGroup: z.string().min(1),
    scenario: z.string().min(1),
    host: runnerHostSchema,
    repetition: z.number().int().nonnegative(),
    split: z.enum(["pilot", "confirmation", "learning"]),
    status: z.enum(["accepted", "rejected", "failed", "cancelled", "timed-out", "attrited"]),
    receiptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    accepted: z.boolean(),
    severeDefects: z.number().int().nonnegative(),
    modelUsd: z.number().finite().nonnegative().nullable(),
    executionUsd: z.number().finite().nonnegative().nullable(),
    reviewMinutes: z.number().finite().nonnegative().nullable(),
    reviewerHourlyUsd: z.number().finite().nonnegative().nullable(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict()
  .refine(
    (row) => row.accepted === (row.status === "accepted"),
    "Acceptance must agree with terminal status",
  );
export type StudyObservation = z.infer<typeof studyObservationSchema>;

export const preregistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    study: z.string().min(1),
    frozenAt: z.string().datetime(),
    analysisPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    referenceArm: z.string().min(1),
    treatmentArm: z.string().min(1),
    learningRepositories: z.array(z.string()),
    pilotRepositories: z.array(z.string()),
    assignments: z
      .array(
        assignmentSchema
          .extend({
            host: runnerHostSchema,
            runId: z.string().min(1),
            split: z.literal("confirmation"),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();
export type Preregistration = z.infer<typeof preregistrationSchema>;

export const confirmationSchema = z
  .object({
    schemaVersion: z.literal(1),
    study: z.string().min(1),
    preregistrationHash: z.string().regex(/^[a-f0-9]{64}$/),
    preregistration: preregistrationSchema,
    observationHash: z.string().regex(/^[a-f0-9]{64}$/),
    analysis: z.literal("preregistered-repository-clustered"),
    analysisReportHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptanceDifferenceLower95: z
      .object({
        codex: z.number().finite().min(-1).max(1).optional(),
        claude: z.number().finite().min(-1).max(1).optional(),
      })
      .strict(),
    adjudication: z.literal("independent-reviewed"),
  })
  .strict();
export type Confirmation = z.infer<typeof confirmationSchema>;

export function summarizeStudy(input: readonly StudyObservation[], confirmed?: Confirmation) {
  const rows = input.map((row) => studyObservationSchema.parse(row));
  if (new Set(rows.map((row) => row.runId)).size !== rows.length)
    throw new Error("Duplicate run identity");
  const arms = [...new Set(rows.map((row) => `${row.host}:${row.arm}`))]
    .sort()
    .map((key) => summarizeArm(rows.filter((row) => `${row.host}:${row.arm}` === key)));
  return {
    schemaVersion: 1 as const,
    observationHash: hashValue(rows),
    arms,
    promotion: promotionDecision(rows, arms, confirmed),
  };
}

function summarizeArm(rows: readonly StudyObservation[]) {
  const costs = rows.map(observationCost);
  const totalUsd = costs.includes(null)
    ? null
    : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const accepted = rows.filter((row) => row.accepted).length;
  const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  return {
    arm: rows[0]?.arm ?? "unknown",
    host: rows[0]?.host ?? "unknown",
    attempts: rows.length,
    accepted,
    statuses: Object.fromEntries(
      ["accepted", "rejected", "failed", "cancelled", "timed-out", "attrited"].map((status) => [
        status,
        rows.filter((row) => row.status === status).length,
      ]),
    ),
    acceptanceRate: accepted / rows.length,
    severeDefects: rows.reduce((sum, row) => sum + row.severeDefects, 0),
    totalUsd,
    costPerAcceptedTaskUsd: accepted && totalUsd !== null ? totalUsd / accepted : null,
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
  };
}

function observationCost(row: StudyObservation): number | null {
  if (
    row.modelUsd === null ||
    row.executionUsd === null ||
    row.reviewMinutes === null ||
    row.reviewerHourlyUsd === null
  )
    return null;
  return row.modelUsd + row.executionUsd + (row.reviewMinutes * row.reviewerHourlyUsd) / 60;
}

function promotionDecision(
  rows: readonly StudyObservation[],
  arms: ReturnType<typeof summarizeArm>[],
  input?: Confirmation,
) {
  const review = (reason: string, reportedTargetsMet = false) => ({
    eligible: false as const,
    reportedTargetsMet,
    reason,
    provenance: "operator-supplied-analysis" as const,
  });
  if (!input)
    return review(
      "A pilot cannot establish promotion; a preregistered confirmatory analysis is required",
    );
  const confirmation = confirmationSchema.parse(input);
  const binding = confirmationBinding(rows, confirmation);
  if (binding) return review(binding);
  for (const host of new Set(rows.map((row) => row.host))) {
    const treatment = arms.find(
      (arm) => arm.host === host && arm.arm === confirmation.preregistration.treatmentArm,
    );
    const reference = arms.find(
      (arm) => arm.host === host && arm.arm === confirmation.preregistration.referenceArm,
    );
    const issue = hostTargetIssue(
      treatment,
      reference,
      confirmation.acceptanceDifferenceLower95[host],
    );
    if (issue) return review(issue);
  }
  return review(
    "Bound operator analysis meets the reported targets; external receipt verification, statistical review, and human activation remain required",
    true,
  );
}

function hostTargetIssue(
  treatment: ReturnType<typeof summarizeArm> | undefined,
  reference: ReturnType<typeof summarizeArm> | undefined,
  lower: number | undefined,
): string | undefined {
  if (!treatment || !reference || treatment === reference)
    return "Distinct paired comparison arms are required for every host";
  if (treatment.severeDefects || reference.severeDefects)
    return "Severe regressions prevent promotion";
  if (lower === undefined || lower <= -0.02)
    return "Reported host-stratified acceptance non-inferiority target is not established";
  if (
    treatment.costPerAcceptedTaskUsd === null ||
    reference.costPerAcceptedTaskUsd === null ||
    reference.costPerAcceptedTaskUsd <= 0
  )
    return "Complete cost and acceptance evidence is required";
  if (1 - treatment.costPerAcceptedTaskUsd / reference.costPerAcceptedTaskUsd < 0.25)
    return "Reported cost reduction is below the 25 percent target";
  return undefined;
}

function confirmationBinding(
  rows: readonly StudyObservation[],
  confirmation: Confirmation,
): string | undefined {
  const planned = confirmation.preregistration;
  if (
    confirmation.preregistrationHash !== hashValue(planned) ||
    confirmation.study !== planned.study
  )
    return "Preregistration digest or study does not match";
  if (confirmation.observationHash !== hashValue(rows))
    return "Confirmatory analysis refers to different observations";
  if (planned.assignments.length !== rows.length)
    return "Preregistered observations are incomplete or exceeded";
  if (
    rows.some(
      (row) => row.split !== "confirmation" || row.status === "attrited" || !row.receiptHash,
    )
  )
    return "Pilot, learning, attrited, or unreceipted observations cannot establish confirmation";
  return matchingAssignments(rows, planned);
}

function matchingAssignments(
  rows: readonly StudyObservation[],
  planned: Preregistration,
): string | undefined {
  const assignments = new Map(planned.assignments.map((row) => [row.runId, row]));
  if (assignments.size !== rows.length) return "Duplicate preregistered run identities";
  const excluded = new Set([...planned.learningRepositories, ...planned.pilotRepositories]);
  const pairs = new Map<string, Set<string>>();
  for (const row of rows) {
    const assignment = assignments.get(row.runId);
    if (
      !assignment ||
      assignment.study !== planned.study ||
      assignmentKey(assignment) !== assignmentKey(row)
    )
      return "Observation differs from its frozen assignment";
    if (excluded.has(row.repositoryGroup))
      return "Confirmation repositories overlap pilot or learning data";
    if (![planned.referenceArm, planned.treatmentArm].includes(row.arm))
      return "Unexpected arm in confirmatory comparison";
    const key = JSON.stringify([row.repositoryGroup, row.scenario, row.host, row.repetition]);
    const arms = pairs.get(key) ?? new Set<string>();
    if (arms.has(row.arm)) return "Duplicate observation in a matched comparison pair";
    arms.add(row.arm);
    pairs.set(key, arms);
  }
  if ([...pairs.values()].some((arms) => arms.size !== 2))
    return "Every host/repository/scenario/repetition requires a complete comparison pair";
  return undefined;
}

function assignmentKey(
  row: Pick<
    StudyObservation,
    "arm" | "repositoryGroup" | "scenario" | "host" | "repetition" | "split"
  >,
): string {
  return JSON.stringify([
    row.arm,
    row.repositoryGroup,
    row.scenario,
    row.host,
    row.repetition,
    row.split,
  ]);
}

function percentile(values: readonly number[], fraction: number): number {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

export interface EscalationInput {
  readonly remainingUsd: number;
  readonly remainingMs: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly escalationEstimatedUsd: number;
  readonly escalationMinimumMs: number;
  readonly failure: "infrastructure" | "verification" | "uncertain" | "none";
  readonly evidenceIds: readonly string[];
}
export function decideEscalation(input: EscalationInput) {
  if (
    Object.values(input).some(
      (value) => typeof value === "number" && (!Number.isFinite(value) || value < 0),
    )
  )
    throw new Error("Escalation budgets must be finite and nonnegative");
  if (input.failure === "none")
    return { action: "finish" as const, reason: "No failure requires escalation" };
  if (input.failure === "infrastructure")
    return {
      action: "repair-environment" as const,
      reason: "Model changes cannot repair missing execution prerequisites",
    };
  if (!input.evidenceIds.length)
    return {
      action: "request-evidence" as const,
      reason: "A bounded handoff requires attributable failure evidence",
    };
  if (
    input.attempts >= input.maxAttempts ||
    input.remainingUsd < input.escalationEstimatedUsd ||
    input.remainingMs < input.escalationMinimumMs
  )
    return {
      action: "stop" as const,
      reason: "The remaining approved budget cannot fund escalation",
    };
  return {
    action: "escalate" as const,
    reason: "A further explicitly configured attempt fits the evidence and budget limits",
  };
}
