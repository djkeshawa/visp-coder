import { matchesAny } from "../../core/patterns.js";
import type { WorkspaceState } from "../state.js";
import { pinnedAcceptanceChecks } from "./acceptance-checks.js";
import { applicableExecutions, applicableReviews } from "./assessment.js";
import { currentFailedJourneys } from "./evidence-references.js";
import { findingAppliesToSlice, outstandingFeedback } from "./feedback.js";
import type { ProductCheck, ProductExecution, ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

export function currentProductFailures(record: ProductRecord, subject: string): ProductExecution[] {
  return [
    ...new Map(
      applicableExecutions(record, subject).map((entry) => [executionOwnerKey(entry), entry]),
    ).values(),
  ].filter((entry) => entry.status !== "passed");
}

/** Explicit check ownership is strongest; outcome and concrete input paths narrow assembled checks. */
export function failedCheckOwners(
  record: ProductRecord,
  execution: ProductExecution,
): ProductSlice[] {
  if (execution.status !== "failed") return [];
  const check = [...record.brief.checks, ...pinnedAcceptanceChecks(record.brief)].find(
    (entry) => entry.id === execution.check,
  );
  if (!check) return [];
  if (execution.task) {
    const selected = record.brief.slices.find((slice) => slice.id === execution.task);
    return selected?.checks.includes(check.id) ? [selected] : [];
  }
  const explicit = record.brief.slices.filter((slice) => slice.checks.includes(check.id));
  if (explicit.length) return explicit;
  const outcomes = record.brief.slices.filter((slice) =>
    check.outcomes.some((id) => slice.outcomes.includes(id)),
  );
  const paths = record.brief.slices.filter((slice) => ownsCheckPath(slice, check));
  if (!outcomes.length) return paths;
  const narrowed = outcomes.filter((slice) => paths.includes(slice));
  return narrowed.length ? narrowed : outcomes;
}

function ownsCheckPath(slice: ProductSlice, check: ProductCheck): boolean {
  return check.files
    .filter((path) => !/[*?[]/.test(path))
    .some(
      (path) => matchesAny(path, slice.scope.allowed) && !matchesAny(path, slice.scope.forbidden),
    );
}

export function reviewCorrectionOutcomes(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): string[] {
  const latest = new Map(
    applicableReviews(record, subject, slice).flatMap((review) =>
      review.assessments.map((assessment) => [assessment.outcome, assessment] as const),
    ),
  );
  const findings = outstandingFeedback(record).filter(
    (entry) => entry.required && findingAppliesToSlice(entry, slice),
  );
  return record.brief.outcomes
    .filter((outcome) => {
      if (!slice.outcomes.includes(outcome.id)) return false;
      const assessment = latest.get(outcome.id);
      return (
        findings.some(
          (finding) => !finding.outcomes.length || finding.outcomes.includes(outcome.id),
        ) ||
        (outcome.priority === "must" &&
          (assessment?.status === "failed" ||
            assessment?.expectations.some((entry) => entry.status === "failed")))
      );
    })
    .map((outcome) => outcome.id);
}

export function correctionReasons(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): string[] {
  return [
    ...reviewCorrectionOutcomes(record, slice, subject),
    ...currentFailedJourneys(record, subject)
      .filter((run) => run.task === slice.id && run.failure?.kind === "behavior")
      .map((run) => `journey ${run.id ?? run.journeyDigest}: ${run.failure?.message}`),
    ...currentProductFailures(record, subject)
      .filter((execution) =>
        failedCheckOwners(record, execution).some((owner) => owner.id === slice.id),
      )
      .map((execution) => `check ${execution.check}`),
  ];
}

/** Old failures select checks to rerun after code edits; they never supply passing/current evidence. */
export function correctionChecks(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): ProductCheck[] {
  const currentContract = record.state.executions.filter((execution) => {
    const owner = execution.task
      ? record.brief.slices.find((entry) => entry.id === execution.task)
      : undefined;
    return (
      execution.status === "failed" &&
      (!execution.task || owner !== undefined) &&
      execution.contractDigest === productContractDigest(record.brief, owner)
    );
  });
  // Historical failures request a recheck after edits; only current evidence supersedes them.
  const latest = [
    ...new Map(
      [...currentContract, ...applicableExecutions(record, subject)].map((entry) => [
        executionOwnerKey(entry),
        entry,
      ]),
    ).values(),
  ];
  const ids = new Set(
    latest
      .filter((execution) =>
        failedCheckOwners(record, execution).some((owner) => owner.id === slice.id),
      )
      .map((execution) => execution.check),
  );
  return [...record.brief.checks, ...pinnedAcceptanceChecks(record.brief)].filter((check) =>
    ids.has(check.id),
  );
}

function executionOwnerKey(execution: ProductExecution): string {
  return JSON.stringify([execution.check, execution.task]);
}

/** The same selected checks inform baseline navigation and optional critic readiness. */
export function sliceExecutionCheckIds(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): Set<string> {
  return new Set([
    ...slice.checks,
    ...correctionChecks(record, slice, subject).map((check) => check.id),
    ...workspace.config.workflow.validationCommands.map((_, index) => `CONFIG_${index + 1}`),
  ]);
}
