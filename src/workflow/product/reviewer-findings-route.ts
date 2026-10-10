import type { WorkspaceState } from "../state.js";
import { pinnedAcceptanceChecks } from "./acceptance-checks.js";
import { applicableExecutions } from "./assessment.js";
import { currentProductFailures, sliceExecutionCheckIds } from "./corrections.js";
import { type ReviewerCapacity, reviewerHandoff } from "./critic-capacity.js";
import { currentJourneyFailures } from "./evidence-references.js";
import { findingAppliesToSlice, outstandingFeedback } from "./feedback.js";
import { closedSlice, type ProductSlice } from "./model.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";

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
  const findings = outstandingFeedback(record).filter((finding) => finding.required);
  const slice = record.brief.slices.find((entry) =>
    findings.some((finding) => findingAppliesToSlice(finding, entry)),
  );
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
  const scopes = requiredFindingScopes(workspace, record, subject);
  const repair =
    scopes.find((scope) => !scope.ready) ??
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
    scopes.every((scope) => scope.ready) &&
    !currentProductFailures(record, subject).length &&
    !currentJourneyFailures(record, subject).length
  )
    return { ...base, ...reviewerHandoff(record.brief.feature, capacity, "findings") };
  return {
    ...base,
    action: "fix",
    completion: "unresolved-product",
    command: `visp work --feature ${record.brief.feature} --task ${repair.slice.id}`,
    objective: `${capacity.reason ? `${capacity.reason} ` : ""}VISP's independent reviewer cannot run again. The listed required findings are still open. Fix each reported problem, extend your checks to exercise it, and rerun visp done.`,
  };
}

/** A feature-level PR must not skip another slice's untouched findings or stale checks. */
function requiredFindingScopes(workspace: WorkspaceState, record: ProductRecord, subject: string) {
  const required = outstandingFeedback(record).filter((finding) => finding.required);
  return record.brief.slices.flatMap((slice) => {
    const findings = required.filter((finding) => findingAppliesToSlice(finding, slice));
    if (!findings.length) return [];
    const productFindings = findings.some((finding) => finding.phase === "product");
    const latest = record.state.reviews.findLast(
      (review) =>
        (!review.task || review.task === slice.id) &&
        (!productFindings || review.feedback?.phase !== "understanding") &&
        review.reviewer?.context !== "unavailable",
    );
    // Repeated findings retain their original digest; compare the latest completed review too.
    const changed =
      latest !== undefined &&
      latest.subjectDigest !== subject &&
      findings.every((finding) => finding.subjectDigest !== subject);
    return [
      { slice, findings, ready: changed && currentChecksPass(workspace, record, slice, subject) },
    ];
  });
}

function currentChecksPass(
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
