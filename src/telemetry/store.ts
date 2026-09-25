import { vispError } from "../core/errors.js";
import { err, ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import { mutateTelemetry, readTelemetryJournal } from "./journal.js";
import type { Attempt, CheckEvent, CheckStage, Telemetry, UsageReceipt } from "./schema.js";

export type {
  Attempt,
  CheckEvent,
  CheckSource,
  CheckStage,
  Telemetry,
  UsageReceipt,
} from "./schema.js";
export { usageReceiptSchema } from "./schema.js";

export async function readTelemetry(state: WorkspaceState): Promise<Result<Telemetry>> {
  return readTelemetryJournal(state);
}

export interface UsageImportOutcome {
  readonly imported: boolean;
  readonly receipt: UsageReceipt;
}

export async function recordUsageReceipt(
  state: WorkspaceState,
  receipt: UsageReceipt,
): Promise<Result<UsageImportOutcome>> {
  if (!state.config.telemetry.enabled) {
    return err(
      vispError("UNSUPPORTED", "Telemetry is turned off for this project", {
        recovery: "Set telemetry.enabled to true in visp.yml",
      }),
    );
  }
  return mutateTelemetry<UsageImportOutcome>(state, (current) => {
    const existing = current.usageReceipts.find(
      (candidate) => candidate.source === receipt.source && candidate.runId === receipt.runId,
    );
    if (existing?.sourceFileHash === receipt.sourceFileHash)
      return ok({ value: { imported: false, receipt: existing } });
    if (existing)
      return err(
        vispError(
          "ARTIFACT_INVALID",
          `${receipt.source} run ${receipt.runId} was already imported from different content`,
          {
            details: {
              existingHash: existing.sourceFileHash,
              incomingHash: receipt.sourceFileHash,
            },
          },
        ),
      );
    return ok({ event: { type: "usage", value: receipt }, value: { imported: true, receipt } });
  });
}

/**
 * A token figure and the attempts it actually covers. The two travel together
 * so a caller cannot print the sum without printing its reach: a total over
 * three of eight attempts is a different claim from a total over eight.
 */
export interface ReportedTokens {
  /** Absent when no attempt reported a count. Absent is not zero. */
  readonly total: number | undefined;
  readonly fromAttempts: number;
}

/**
 * Everything on this side of the report came from the agent's own account of
 * its run, which is the one kind of claim visp exists not to trust. It is kept
 * in its own object so no rendering can quietly mix it with measured figures.
 */
export interface SelfReportedCost {
  readonly inputTokens: ReportedTokens;
  readonly outputTokens: ReportedTokens;
  /** Distinct model names claimed, in first-seen order. */
  readonly models: readonly string[];
  /** Attempts that volunteered no counts at all. */
  readonly attemptsWithoutCost: number;
}

export interface TelemetryReport {
  /** Legacy closure attempts, retained for backward compatibility. */
  readonly attempts: number;
  /** First-check pass rates, derived from checks rather than agent claims. */
  readonly verifiedRate: number | undefined;
  readonly reviewedRate: number | undefined;
  readonly workflow: {
    readonly verify: CheckStageReport;
    readonly review: CheckStageReport;
  };
  readonly measuredUsage: MeasuredUsage;
  readonly selfReportedCost: SelfReportedCost;
}

export interface CheckStageReport {
  readonly checks: number;
  readonly tasks: number;
  readonly firstPassRate: number | undefined;
  readonly recoveredTasks: number;
}

export interface MeasuredUsage {
  readonly receipts: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

export function summarize(telemetry: Telemetry): TelemetryReport {
  const attempts = telemetry.attempts;
  const withCost = attempts.filter(
    (attempt) => attempt.inputTokens !== undefined || attempt.outputTokens !== undefined,
  );

  const verify = checkStageReport(telemetry.checks, "verify");
  const review = checkStageReport(telemetry.checks, "review");

  return {
    attempts: attempts.length,
    verifiedRate: verify.firstPassRate,
    reviewedRate: review.firstPassRate,
    workflow: { verify, review },
    measuredUsage: measuredUsage(telemetry.usageReceipts),
    selfReportedCost: {
      inputTokens: reported(attempts, (attempt) => attempt.inputTokens),
      outputTokens: reported(attempts, (attempt) => attempt.outputTokens),
      models: models(attempts),
      attemptsWithoutCost: attempts.length - withCost.length,
    },
  };
}

function checkStageReport(checks: readonly CheckEvent[], stage: CheckStage): CheckStageReport {
  const forStage = checks.filter((check) => check.stage === stage);
  const byTask = new Map<string, CheckEvent[]>();
  for (const check of forStage) {
    if (!check.task) continue;
    const key = `${check.feature}\0${check.task}`;
    const existing = byTask.get(key) ?? [];
    existing.push(check);
    byTask.set(key, existing);
  }

  const histories = [...byTask.values()];
  const firstPasses = histories.filter((history) => history[0]?.outcome === "passed").length;
  const recoveredTasks = histories.filter(
    (history) =>
      history[0]?.outcome !== "passed" && history.some((check) => check.outcome === "passed"),
  ).length;

  return {
    checks: forStage.length,
    tasks: histories.length,
    firstPassRate: histories.length === 0 ? undefined : firstPasses / histories.length,
    recoveredTasks,
  };
}

function measuredUsage(receipts: readonly UsageReceipt[]): MeasuredUsage {
  return {
    receipts: receipts.length,
    inputTokens: sum(receipts, (receipt) => receipt.inputTokens),
    cachedInputTokens: sum(receipts, (receipt) => receipt.cachedInputTokens),
    outputTokens: sum(receipts, (receipt) => receipt.outputTokens),
    reasoningTokens: sum(receipts, (receipt) => receipt.reasoningTokens),
    models: distinct(
      receipts.flatMap(
        (receipt) => receipt.segments?.map((segment) => segment.model) ?? [receipt.model],
      ),
      (model) => model,
    ),
    efforts: distinct(
      receipts.flatMap(
        (receipt) => receipt.segments?.map((segment) => segment.effort) ?? [receipt.effort],
      ),
      (effort) => effort,
    ),
  };
}

function sum<T>(values: readonly T[], pick: (value: T) => number): number {
  return values.reduce((total, value) => total + pick(value), 0);
}

function distinct<T>(values: readonly T[], pick: (value: T) => string | undefined): string[] {
  return [...new Set(values.map(pick).filter((value): value is string => value !== undefined))];
}

/**
 * Sums only the attempts that carried a count. Treating a missing count as zero
 * would turn "nobody said" into "it cost nothing", which is the failure this
 * whole split exists to prevent.
 */
function reported(
  attempts: readonly Attempt[],
  pick: (a: Attempt) => number | undefined,
): ReportedTokens {
  const counts = attempts.map(pick).filter((count): count is number => count !== undefined);
  if (counts.length === 0) return { total: undefined, fromAttempts: 0 };

  return {
    total: counts.reduce((running, count) => running + count, 0),
    fromAttempts: counts.length,
  };
}

function models(attempts: readonly Attempt[]): readonly string[] {
  const named = attempts
    .map((attempt) => attempt.model)
    .filter((model): model is string => model !== undefined);
  return [...new Set(named)];
}
