import { cliCommand } from "../../next-action.js";
import type { WorkspaceState } from "../../state.js";
import { applicableExecutions } from "../assessment.js";
import { pinnedAcceptanceChecks } from "../check/acceptance-checks.js";
import { currentProductFailures, sliceExecutionCheckIds } from "../corrections.js";
import { type ReviewerCapacity, reviewerHandoff } from "../critic/critic-capacity.js";
import { currentJourneyFailures } from "../evidence-references.js";
import { outstandingFeedback } from "../feedback.js";
import { findingOwner, requiredFindingOwner } from "../findings.js";
import { closedSlice, type ProductSlice } from "../model.js";
import type { ProductNext } from "../status.js";
import type { ProductRecord } from "../store.js";

/** Closed slices can retain findings, so assembled-product routing uses the same repair gate. */
export function unavailableClosedReviewerFindingsNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
  capacity: ReviewerCapacity,
): ProductNext | undefined {
  if (
    capacity.available ||
    currentProductFailures(record, subject).length ||
    currentJourneyFailures(record, subject).length
  )
    return undefined;
  const slice = requiredFindingOwner(record);
  return slice
    ? unavailableReviewerFindingsNext(workspace, record, slice, subject, capacity)
    : undefined;
}

/** Exhausted review capacity never substitutes for a repair and current passing checks. */
export function unavailableReviewerFindingsNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
  capacity: ReviewerCapacity,
): ProductNext | undefined {
  if (capacity.available) return undefined;
  const scopes = requiredFindingScopes(workspace, record);
  const repair =
    scopes.find((scope) => !scope.repaired.size) ??
    scopes.find((scope) => scope.slice.id === slice.id) ??
    scopes[0];
  if (!repair) return undefined;
  const base = {
    feature: record.brief.feature,
    task: repair.slice.id,
    evidence: repair.findings.map(
      (finding) => `${finding.problem}. Next check: ${finding.nextCheck}`,
    ),
    mayEdit: true,
  };
  if (
    scopes.every((scope) => scope.repaired.size > 0) &&
    scopes.some((scope) => scope.repaired.has(subject)) &&
    !currentProductFailures(record, subject).length &&
    !currentJourneyFailures(record, subject).length
  )
    return { ...base, ...reviewerHandoff(record.brief.feature, capacity, "findings") };
  return {
    ...base,
    action: "fix",
    completion: "unresolved-product",
    command: cliCommand("work", { feature: record.brief.feature, task: repair.slice.id }),
    objective: `${capacity.reason ? `${capacity.reason} ` : ""}VISP's independent reviewer cannot run again. The listed required findings are still open. Fix each reported problem, extend your checks to exercise it, and rerun visp done.`,
  };
}

/**
 * A feature-level PR must not skip another slice's untouched findings. Each finding belongs to
 * one slice, and a repair round counts once it passed that slice's checks on a later version:
 * slices that share files would otherwise stale each other's repairs and alternate forever.
 */
function requiredFindingScopes(workspace: WorkspaceState, record: ProductRecord) {
  const required = outstandingFeedback(record).filter((finding) => finding.required);
  return record.brief.slices.flatMap((slice) => {
    const findings = required.filter(
      (finding) => findingOwner(finding, record.brief.slices)?.id === slice.id,
    );
    if (!findings.length) return [];
    const productFindings = findings.some((finding) => finding.phase === "product");
    const latest = record.state.reviews.findLast(
      (review) =>
        (!review.task || review.task === slice.id) &&
        (!productFindings || review.feedback?.phase !== "understanding") &&
        review.reviewer?.context !== "unavailable",
    );
    if (!latest) return [{ slice, findings, repaired: new Set<string>() }];
    // Repeated findings retain their original digest; exclude the latest review's version too.
    const reviewed = new Set([
      latest.subjectDigest,
      ...findings.map((entry) => entry.subjectDigest),
    ]);
    const later = record.state.executions.filter(
      (execution) =>
        execution.createdAt >= latest.createdAt && !reviewed.has(execution.subjectDigest),
    );
    const versions = new Set(later.map((execution) => execution.subjectDigest));
    const repaired = new Set(
      [...versions].filter((version) => checksPass(workspace, record, slice, version)),
    );
    return [{ slice, findings, repaired }];
  });
}

function checksPass(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
) {
  const checks = sliceExecutionCheckIds(workspace, record, slice, subject);
  if (
    record.brief.slices.every(
      (entry) => entry.id === slice.id || closedSlice(record.state.slices[entry.id]?.status),
    )
  )
    for (const check of pinnedAcceptanceChecks(record.brief)) checks.add(check.id);
  const executions = applicableExecutions(record, subject).filter(
    (execution) =>
      execution.task === slice.id || (!execution.task && !slice.checks.includes(execution.check)),
  );
  const latest = new Map(executions.map((execution) => [execution.check, execution]));
  return checks.size > 0 && [...checks].every((check) => latest.get(check)?.status === "passed");
}
