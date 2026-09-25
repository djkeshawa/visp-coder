import { applicableExecutions, applicableReviews } from "../../workflow/product/assessment.js";
import type { ProductRecord } from "../../workflow/product/store.js";

export interface ProductCapabilityFact {
  readonly record: ProductRecord;
  /** Historical completion is not reevaluated as replacement-workflow evidence. */
  readonly subject?: string;
}

/** Counts records and current agent judgments, never infers product quality from a receipt. */
export function summarizeProduct(facts: readonly ProductCapabilityFact[]) {
  const summary = {
    features: facts.length,
    activeFeatures: 0,
    recordedAcceptances: 0,
    historicalFeatures: 0,
    incompleteBriefs: 0,
    outcomes: { functional: 0, quality: 0, experience: 0 },
    examples: 0,
    decisions: 0,
    evidenceReferences: 0,
    unresolvedQuestions: 0,
    slices: { pending: 0, inProgress: 0, closed: 0, historicalClosed: 0 },
    executions: {
      recorded: 0,
      passed: 0,
      failed: 0,
      environmentFailed: 0,
      current: 0,
      stale: 0,
      durationMs: 0,
    },
    reviews: { recorded: 0, current: 0, stale: 0 },
    assessments: {
      provenance: "agent-reported" as const,
      satisfied: 0,
      failed: 0,
      unclear: 0,
      unavailable: 0,
      unassessed: 0,
    },
    captureRuns: 0,
    controlRuns: 0,
  };
  for (const { record, subject } of facts) {
    addIntent(summary, record);
    addEvidence(summary, record, subject);
  }
  return summary;
}

export type ProductCapabilitySummary = ReturnType<typeof summarizeProduct>;

function addIntent(summary: ProductCapabilitySummary, record: ProductRecord): void {
  const { brief, state } = record;
  if (state.status === "active") summary.activeFeatures++;
  if (state.status === "accepted") summary.recordedAcceptances++;
  if (state.status === "historical-complete") summary.historicalFeatures++;
  if (brief.incomplete) summary.incompleteBriefs++;
  for (const outcome of brief.outcomes) summary.outcomes[outcome.kind]++;
  summary.examples += brief.examples.length;
  summary.decisions += brief.decisions.length;
  summary.evidenceReferences += brief.decisions.reduce(
    (sum, decision) => sum + decision.evidence.length,
    0,
  );
  summary.unresolvedQuestions += brief.uncertainties.length;
  for (const slice of brief.slices) {
    const status = state.slices[slice.id]?.status ?? "pending";
    const key =
      status === "in-progress"
        ? "inProgress"
        : status === "legacy-closed"
          ? "historicalClosed"
          : status;
    summary.slices[key]++;
  }
}

function addEvidence(
  summary: ProductCapabilitySummary,
  record: ProductRecord,
  subject?: string,
): void {
  const { state, brief } = record;
  const executions = state.executions.filter((entry) => !entry.reusedEnvironmentFailure);
  const currentExecutions = subject
    ? applicableExecutions(record, subject).filter((entry) => !entry.reusedEnvironmentFailure)
    : [];
  const currentReviews = subject ? applicableReviews(record, subject) : [];
  summary.executions.recorded += executions.length;
  summary.executions.current += currentExecutions.length;
  summary.executions.stale += executions.length - currentExecutions.length;
  for (const execution of executions) {
    const key = execution.status === "environment-failed" ? "environmentFailed" : execution.status;
    summary.executions[key]++;
    summary.executions.durationMs += execution.durationMs;
  }
  summary.reviews.recorded += state.reviews.length;
  summary.reviews.current += currentReviews.length;
  summary.reviews.stale += state.reviews.length - currentReviews.length;
  summary.captureRuns += state.captureRuns.length;
  summary.controlRuns += state.controls.length;
  if (state.status === "historical-complete") return;
  const latest = new Map(
    currentReviews.flatMap((review) =>
      review.assessments.map((assessment) => [assessment.outcome, assessment] as const),
    ),
  );
  for (const outcome of brief.outcomes) {
    const assessment = latest.get(outcome.id);
    summary.assessments[assessment?.status ?? "unassessed"]++;
  }
}
