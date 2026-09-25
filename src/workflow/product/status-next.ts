import { ok, type Result } from "../../core/result.js";
import { recordedReplayRuns, replayCommand } from "../evidence/capture-replay.js";
import type { WorkspaceState } from "../state.js";
import {
  applicableExecutions,
  applicableReviews,
  finalProductAssessmentGaps,
  outcomeStatuses,
  type ProductOutcomeStatus,
  productEvidenceGaps,
  productImageEvidenceGaps,
} from "./assessment.js";
import {
  currentProductFailures,
  failedCheckOwners,
  reviewCorrectionOutcomes,
  sliceExecutionCheckIds,
} from "./corrections.js";
import { unconfiguredCriticSpending } from "./critic-budget.js";
import { browserEnvironmentIdentity, environmentNext, needsBrowser } from "./environment.js";
import {
  currentFailedJourneys,
  currentJourneyFailures,
  latestCurrentJourneys,
} from "./evidence-references.js";
import { findingAppliesToSlice, outstandingFeedback, productFeedbackGaps } from "./feedback.js";
import { functionalRegressionRequirement } from "./functional-regression.js";
import { findFunctionalRepair } from "./functional-resolution.js";
import { checksFor, closedSlice, type ProductSlice } from "./model.js";
import { productRefinement } from "./refinement.js";
import { repairRecheck } from "./repair-recheck.js";
import { readProductAuthorization, selectProductSlice } from "./scopes.js";
import type { ProductNext } from "./status.js";
import { historicalAcceptanceNext, type ProductIdentity } from "./status-history.js";
import type { ProductRecord, ProductSelection } from "./store.js";

export async function nextFromRecord(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
  getIdentity: () => Promise<Result<ProductIdentity>>,
): Promise<Result<ProductNext>> {
  const selection = selectProductSlice(workspace, record, options, true);
  if (!selection.ok) return selection;
  const slice = selection.value;
  const base = { feature: record.brief.feature, ...(slice ? { task: slice.id } : {}) };
  if (record.state.status === "historical-complete")
    return ok({
      ...base,
      action: "complete",
      objective: "Historically completed feature; original evidence is preserved",
      evidence: ["This is historical completion, not fresh product verification"],
      mayEdit: false,
    });
  if (record.brief.incomplete || !record.brief.outcomes.length || !record.brief.slices.length)
    return ok({
      ...base,
      action: "understand",
      objective:
        "Work the whole request as one slice with your test command, or, for several independently usable parts, describe outcomes and slices in the brief",
      command: `visp work --feature ${record.brief.feature} --check "<command that runs your tests>"`,
      evidence: record.brief.uncertainties,
      mayEdit: false,
    });
  const environment = await unavailableEnvironmentNext(workspace, record, slice);
  if (environment) return ok(environment);
  const identity = await getIdentity();
  if (!identity.ok) return identity;
  const subject = ok(identity.value.subject);
  const historical = historicalAcceptanceNext(record, identity.value, base);
  if (historical) return ok(historical);
  if (await hasCurrentAcceptance(workspace, record, subject.value))
    return ok({
      ...base,
      action: "complete",
      objective: "Required product outcomes have current acceptance evidence",
      evidence: [],
      mayEdit: false,
    });
  const allClosed = record.brief.slices.every((entry) =>
    closedSlice(record.state.slices[entry.id]?.status),
  );
  if (allClosed) return nextClosedProduct(workspace, record, subject.value);
  if (!slice)
    return ok({
      ...base,
      action: "understand",
      objective: "Resolve the remaining slice dependencies",
      command: `visp brief --feature ${record.brief.feature}`,
      evidence: [],
      mayEdit: false,
    });
  return nextOpenSlice(workspace, record, slice, subject.value);
}

async function hasCurrentAcceptance(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
) {
  return (
    record.state.status === "accepted" &&
    record.state.acceptedSubject === subject &&
    currentProductFailures(record, subject).length === 0 &&
    (await productEvidenceGaps(workspace, record, subject)).length === 0 &&
    finalProductAssessmentGaps(record, subject).length === 0
  );
}

async function unavailableEnvironmentNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice?: ProductSlice,
) {
  const capability = record.state.browserCapability;
  if (
    !needsBrowser(record.brief, slice) ||
    capability?.status !== "unavailable" ||
    capability.environment !== (await browserEnvironmentIdentity(workspace.paths.root))
  )
    return undefined;
  const rerun =
    record.state.executions.some((entry) => entry.status === "environment-failed") ||
    record.brief.slices.every((entry) => closedSlice(record.state.slices[entry.id]?.status));
  const next = environmentNext(
    record.brief.feature,
    slice?.id,
    [capability.detail],
    rerun ? "verify" : "work",
  );
  if (slice && !closedSlice(record.state.slices[slice.id]?.status)) {
    const authorization = await readProductAuthorization(workspace, record);
    if (!authorization.ok || authorization.value?.task !== slice.id) return undefined;
    return {
      ...next,
      mayEdit: true,
      objective: "Continue within authorized scope; recover the browser before acceptance",
    };
  }
  return next;
}

async function nextClosedProduct(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
): Promise<Result<ProductNext>> {
  const failures = currentProductFailures(record, subject);
  const environmentFailures = failures.filter((entry) => entry.status === "environment-failed");
  if (environmentFailures.length)
    return ok(
      environmentNext(
        record.brief.feature,
        undefined,
        environmentFailures.map((entry) => `${entry.check}: ${entry.output}`),
        "verify",
      ),
    );
  if (!failures.length) {
    const environmentJourney = environmentJourneyNext(
      record,
      subject,
      currentFailedJourneys(record, subject),
    );
    if (environmentJourney) return ok(environmentJourney);
  }
  const journeys = currentJourneyFailures(record, subject);
  const gaps = [
    ...(await productEvidenceGaps(workspace, record, subject)),
    ...failures.map((execution) => `${execution.check}: ${execution.status}: ${execution.output}`),
  ];
  const assessmentGaps = finalProductAssessmentGaps(record, subject);
  const correction =
    record.brief.slices.find((slice) =>
      currentFailedJourneys(record, subject).some(
        (run) => run.task === slice.id && run.failure?.kind === "behavior",
      ),
    ) ??
    record.brief.slices.find(
      (slice) =>
        reviewCorrectionOutcomes(record, slice, subject).length > 0 ||
        requiredFindings(record, slice).length > 0,
    ) ??
    failures
      .map((execution) => failedCheckOwners(record, execution))
      .find((owners) => owners.length === 1)?.[0];
  if (correction && productRefinement(record, correction).exhausted)
    return exhaustedNext(record, correction, [...gaps, ...assessmentGaps]);
  if (correction)
    return ok({
      feature: record.brief.feature,
      task: correction.id,
      action: "fix",
      objective:
        "Reopen the implicated slice and correct the current product finding or failed assembled check",
      command: `visp work --feature ${record.brief.feature} --task ${correction.id}`,
      evidence: [...gaps, ...assessmentGaps],
      mayEdit: false,
    });
  if (failures.length)
    return ok({
      feature: record.brief.feature,
      action: "understand",
      objective:
        "Resolve the current execution failure and select its focused correction scope. If no existing slice owns the failed check, link its outcome or code paths in the brief before reauthorizing.",
      command: `visp brief --feature ${record.brief.feature}`,
      evidence: [...gaps, ...assessmentGaps],
      mayEdit: false,
    });
  const refine =
    assessmentGaps.length > 0 ||
    journeys.length > 0 ||
    (await productImageEvidenceGaps(workspace, record, subject)).length > 0;
  return ok({
    feature: record.brief.feature,
    ...finalStep(workspace, record, refine),
    evidence: [...gaps, ...assessmentGaps],
    mayEdit: false,
  });
}

function finalStep(workspace: WorkspaceState, record: ProductRecord, refine: boolean) {
  const feature = record.brief.feature;
  if (!refine)
    return {
      action: "accept" as const,
      objective: "Run final checks against the assembled product and preserved expectations",
      command: `visp accept --feature ${feature}`,
    };
  return reviewerRuns(workspace)
    ? {
        action: "refine" as const,
        objective:
          "Run visp accept; VISP's independent reviewer assesses the assembled product first",
        command: `visp accept --feature ${feature}`,
      }
    : {
        action: "refine" as const,
        objective:
          "Review the assembled product against every mandatory outcome and retained expectation",
        command: `visp review --handoff --feature ${feature}`,
      };
}

async function nextOpenSlice(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
): Promise<Result<ProductNext>> {
  const base = { feature: record.brief.feature, task: slice.id };
  const auth = await readProductAuthorization(workspace, record);
  if (!auth.ok) return auth;
  if (auth.value?.task !== slice.id)
    return ok({
      ...base,
      action: "implement",
      objective: slice.goal,
      command: `visp work --feature ${record.brief.feature} --task ${slice.id}`,
      evidence: [],
      mayEdit: false,
    });
  const checks = sliceExecutionCheckIds(workspace, record, slice, subject);
  const executions = applicableExecutions(record, subject).filter(
    (execution) =>
      checks.has(execution.check) &&
      (execution.task === slice.id || (!execution.task && !slice.checks.includes(execution.check))),
  );
  const failures = [
    ...new Map(executions.map((execution) => [execution.check, execution])).values(),
  ].filter((execution) => execution.status !== "passed");
  const environmentFailures = failures.filter((entry) => entry.status === "environment-failed");
  if (environmentFailures.length)
    return ok({
      ...environmentNext(
        record.brief.feature,
        slice.id,
        environmentFailures.map((entry) => `${entry.check}: ${entry.output}`),
        "verify",
      ),
      mayEdit: true,
      objective:
        "Continue the authorized slice while recovering the failed check's execution environment or correcting its command; required checks remain unresolved",
    });
  if (failures.length)
    return ok({
      ...base,
      action: "fix",
      objective:
        "Trace the failing handler or state transition, change the hypothesis when repeated, then rerun the affected check",
      command: `visp work --feature ${record.brief.feature} --task ${slice.id}`,
      evidence: failures.map((entry) => `${entry.check}: ${entry.status}: ${entry.output}`),
      mayEdit: true,
    });
  const journeyNext = failedJourneyNext(record, subject, slice);
  if (journeyNext) return journeyNext;
  const statuses = outcomeStatuses(record, subject, slice);
  const reviewGaps = statuses.filter(
    (entry) =>
      entry.priority === "must" &&
      ((entry.requiredReview && entry.review !== "satisfied") || entry.review === "failed"),
  );
  const hasProductFeedback = applicableReviews(record, subject).some(
    (entry) => (!entry.task || entry.task === slice.id) && entry.feedback?.phase === "product",
  );
  // Surface actual findings and unavailable review without requiring category declarations.
  const qualityGaps = hasProductFeedback ? productFeedbackGaps(record, subject, slice) : [];
  const hasObservedProduct =
    executions.length > 0 ||
    hasProductFeedback ||
    latestCurrentJourneys(record, subject, slice.id).length > 0;
  const findings = requiredFindings(record, slice);
  const reassess = reviewAfterSuccessfulRepair(
    record,
    slice,
    subject,
    findings,
    reviewGaps.some((entry) => entry.review === "failed") ||
      currentReviewFailure(record, subject, slice),
  );
  if (reassess) return ok(reassess);
  if (
    findings.length ||
    (hasObservedProduct && reviewGaps.some((entry) => entry.review === "failed"))
  ) {
    const reviewerRechecks = reviewerRuns(workspace);
    const missingReproduction = unreproducedFindings(
      record,
      findings,
      subject,
      slice,
      reviewerRechecks,
    );
    const route = await repairRoute(workspace, record, slice, missingReproduction.length > 0);
    return ok({
      ...base,
      action: "fix",
      objective: route.objective,
      command: route.command,
      evidence: [
        ...findings.map((finding) => `${finding.problem}. Next check: ${finding.nextCheck}`),
        ...missingReproduction.map(
          (finding) =>
            `${finding.id}: no intact replay target is available from the retained evidence. Establish a relevant executed failure before repair, or supply fresh executed counterevidence for disproof; the original finding remains unresolved.`,
        ),
        ...qualityGaps,
      ],
      mayEdit: true,
      completion: route.completion,
    });
  }
  const reviewNext = nextOpenSliceReview(record, subject, slice, statuses, executions.length > 0);
  if (reviewNext) return ok(reviewNext);
  return ok({
    ...base,
    action: "implement",
    objective: slice.goal,
    command: `visp done --feature ${record.brief.feature} --task ${slice.id}`,
    evidence: await productEvidenceGaps(workspace, record, subject, slice),
    mayEdit: true,
  });
}

async function repairRoute(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
  missingReproduction: boolean,
) {
  const reviewerRechecks = reviewerRuns(workspace);
  if (reviewerRechecks && (await reviewBudgetSpent(workspace, record)))
    return {
      objective:
        "The independent review budget is spent. Fix what you can and rerun your checks, then run visp pr to hand the remaining findings to a human reviewer",
      command: `visp pr --feature ${record.brief.feature}`,
      completion: "handoff" as const,
    };
  return {
    objective: repairObjective(record, slice, missingReproduction, reviewerRechecks),
    command: `visp work --feature ${record.brief.feature} --task ${slice.id}`,
    completion: "unresolved-product" as const,
  };
}

/** VISP launches its own reviewer, so routing never asks the worker to delegate one. */
function reviewerRuns(workspace: WorkspaceState): boolean {
  return workspace.config.critic?.launch === "codex-exec";
}

/**
 * A bounded loop needs an end: once VISP's reviews are spent, open findings are handed to
 * the human reviewer through `visp pr` rather than cycling without a reviewer.
 */
async function reviewBudgetSpent(workspace: WorkspaceState, record: ProductRecord) {
  const spending = await unconfiguredCriticSpending(workspace, record.brief.feature);
  return spending.ok && "callsRemaining" in spending.value && spending.value.callsRemaining === 0;
}

/** A VISP-launched reviewer re-checks open findings itself, so no reproduction is asked for. */
function unreproducedFindings(
  record: ProductRecord,
  findings: ReturnType<typeof requiredFindings>,
  subject: string,
  slice: ProductSlice,
  reviewerRechecks: boolean,
) {
  if (reviewerRechecks) return [];
  return findings.filter(
    (finding) =>
      finding.phase === "product" &&
      finding.dimension === "functional" &&
      !repairRecheck(record, finding, subject, slice.id),
  );
}

function repairObjective(
  record: ProductRecord,
  slice: ProductSlice,
  missingReproduction: boolean,
  reviewerRechecks = false,
) {
  if (reviewerRechecks)
    return "Fix each reported problem and extend your slice check to exercise it, then run visp done; the independent reviewer re-checks these findings";
  if (missingReproduction)
    return "Record a failing reproduction of the reported behavior, or fresh executed counterevidence for separate assessment, before claiming a repair";
  return productRefinement(record, slice).exhausted
    ? "Review budget exhausted; choose a different repair hypothesis. Required outcomes remain unresolved."
    : "Correct the observed product mismatch, then recheck the affected behavior";
}

function currentReviewFailure(record: ProductRecord, subject: string, slice: ProductSlice) {
  return applicableReviews(record, subject).some(
    (review) =>
      (!review.task || review.task === slice.id) &&
      (review.feedback?.dimensions.some((entry) => entry.status === "failed") ||
        review.feedback?.probes?.some((entry) => entry.status === "failed")),
  );
}

/**
 * A fresh successful replay is evidence for a new review, never a resolution.
 * Keep the worker on repair until every retained required finding has an exact
 * current recheck and there are no current failures competing with review.
 */
function reviewAfterSuccessfulRepair(
  record: ProductRecord,
  slice: ProductSlice,
  subject: string,
  findings: ReturnType<typeof outstandingFeedback>,
  currentReviewFailed: boolean,
): ProductNext | undefined {
  if (currentReviewFailed) return undefined;
  if (!findings.length || findings.some((finding) => finding.subjectDigest === subject))
    return undefined;
  const rechecks = findings.map((finding) => ({
    finding,
    recheck: repairRecheck(record, finding, subject, slice.id),
  }));
  if (
    rechecks.some(({ finding, recheck }) => {
      if (
        recheck?.status !== "observed-unassessed" ||
        !("comparison" in recheck) ||
        !recheck.comparison
      )
        return true;
      return (
        recheck.comparison.after.subjectDigest !== subject ||
        !["completed", "passed"].includes(recheck.comparison.after.status ?? "") ||
        (finding.dimension === "functional" &&
          findFunctionalRepair(
            record,
            finding,
            [recheck.comparison.after.runId],
            recheck.environmentRepair,
          )?.subjectDigest !== subject)
      );
    })
  )
    return undefined;
  return {
    feature: record.brief.feature,
    task: slice.id,
    action: "refine",
    objective: rechecks.some(({ recheck }) => recheck?.environmentRepair)
      ? "Assess the observed environment change and successful recheck before deciding whether it repairs the retained finding"
      : "Reassess the repaired product from the fresh successful replay before clearing the retained finding",
    command: `visp review --handoff --feature ${record.brief.feature} --task ${slice.id}`,
    evidence: rechecks.flatMap(({ finding, recheck }) => [
      recheck?.environmentRepair
        ? `${finding.id}: ${recheck.environmentRepair.guidance} Observed environments: ${recheck.environmentRepair.from} -> ${recheck.environmentRepair.to}`
        : `${finding.id}: fresh exact ${recheck?.kind} recheck completed; the retained finding remains unresolved until current review evidence reassesses it`,
      ...(finding.dimension === "functional"
        ? [`${finding.id}: ${functionalRegressionRequirement}`]
        : []),
    ]),
    mayEdit: true,
    completion: "unresolved-product",
  };
}

function nextOpenSliceReview(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice,
  statuses: ProductOutcomeStatus[],
  hasExecutions: boolean,
): ProductNext | undefined {
  const reviewGaps = statuses.filter(
    (entry) =>
      entry.priority === "must" &&
      ((entry.requiredReview && entry.review !== "satisfied") || entry.review === "failed"),
  );
  const reviewOnlyGaps = mandatoryQualityReviewGaps(record, slice, statuses);
  const hasProductFeedback = applicableReviews(record, subject).some(
    (entry) => (!entry.task || entry.task === slice.id) && entry.feedback?.phase === "product",
  );
  // Surface observed review gaps without requiring category declarations.
  const qualityGaps = hasProductFeedback ? productFeedbackGaps(record, subject, slice) : [];
  const hasObservedProduct =
    hasExecutions ||
    hasProductFeedback ||
    latestCurrentJourneys(record, subject, slice.id).length > 0;
  if (!((reviewGaps.length || qualityGaps.length) && hasObservedProduct) && !reviewOnlyGaps.length)
    return undefined;
  const { exhausted } = productRefinement(record, slice);
  return {
    feature: record.brief.feature,
    task: slice.id,
    action: exhausted ? "understand" : "refine",
    objective: exhausted
      ? "Refinement budget exhausted; required outcomes remain unresolved. Choose a focused new hypothesis or revise the budget explicitly."
      : reviewOnlyGaps.length
        ? "Obtain source-backed review evidence for each mandatory quality outcome before completing the slice"
        : "Inspect rendered states and the interaction journey; correct the most consequential mismatch",
    command: sliceReviewCommand(record, slice, exhausted),
    evidence: [
      ...reviewGaps.map((entry) => `${entry.id}: ${entry.review}`),
      ...reviewOnlyGaps.map(
        (entry) => `${entry.id}: behavior ${entry.behavior}; review ${entry.review}`,
      ),
      ...qualityGaps,
    ],
    mayEdit: !exhausted,
    completion: "unresolved-product",
  };
}

function mandatoryQualityReviewGaps(
  record: ProductRecord,
  slice: ProductSlice,
  statuses: ProductOutcomeStatus[],
): ProductOutcomeStatus[] {
  const mappedChecks = checksFor(record.brief, slice);
  return statuses.filter((entry) => {
    const outcome = record.brief.outcomes.find((candidate) => candidate.id === entry.id);
    return (
      entry.priority === "must" &&
      outcome?.kind === "quality" &&
      !mappedChecks.some((check) => check.outcomes.includes(entry.id)) &&
      entry.behavior === "unassessed" &&
      entry.review !== "satisfied"
    );
  });
}

function requiredFindings(record: ProductRecord, slice: ProductSlice) {
  return outstandingFeedback(record).filter(
    (finding) => finding.required && findingAppliesToSlice(finding, slice),
  );
}

function exhaustedNext(
  record: ProductRecord,
  slice: ProductSlice,
  evidence: readonly string[],
): Result<ProductNext> {
  return ok({
    feature: record.brief.feature,
    task: slice.id,
    action: "fix",
    objective:
      "Refinement budget exhausted; required outcomes remain unresolved. Choose a focused new hypothesis; the review budget is unchanged.",
    command: `visp work --feature ${record.brief.feature} --task ${slice.id}`,
    evidence,
    mayEdit: false,
  });
}

function environmentJourneyNext(
  record: ProductRecord,
  subject: string,
  journeys: ReturnType<typeof currentFailedJourneys>,
  selectedTask?: string,
): ProductNext | undefined {
  if (!journeys.length || journeys.some((run) => run.failure?.kind === "behavior"))
    return undefined;
  const ordered = selectedTask
    ? [
        ...journeys.filter((run) => run.task === selectedTask),
        ...journeys.filter((run) => run.task !== selectedTask),
      ]
    : journeys;
  const replay = ordered.find(
    (run) => run.id && recordedReplayRuns(record, run.task).some((entry) => entry.id === run.id),
  );
  const run = replay ?? ordered[0];
  const owner = run?.task;
  const task = selectedTask ?? owner;
  return {
    feature: record.brief.feature,
    ...(task ? { task } : {}),
    action: "understand",
    objective:
      "Recover the browser execution environment, then rerun the same journey before judging product behavior",
    command: replay?.id
      ? replayCommand(record.brief.feature, replay.id, owner)
      : `visp capture --feature ${record.brief.feature}${owner ? ` --task ${owner}` : ""} --from -`,
    evidence: [
      ...currentJourneyFailures(record, subject, selectedTask),
      ...(replay ? [] : ["No intact saved replay is available; supply the original journey."]),
    ],
    mayEdit: false,
    completion: "unresolved-environment",
    recovery:
      "Inspect the recorded browser error, restore the host or runtime access it needs, and rerun the journey. An incomplete journey is neither a product failure nor a pass.",
  };
}

function failedJourneyNext(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice,
): Result<ProductNext> | undefined {
  const base = { feature: record.brief.feature, task: slice.id };
  const journeys = currentFailedJourneys(record, subject, slice.id);
  if (journeys.length) {
    const environmentJourney = environmentJourneyNext(record, subject, journeys, slice.id);
    if (environmentJourney) return ok(environmentJourney);
    const replayable = recordedReplayRuns(record, slice.id);
    const pendingReplay = journeys.every((run) => run.subjectDigest !== subject)
      ? journeys.find(
          (run) =>
            run.failure?.kind === "behavior" && replayable.some((entry) => entry.id === run.id),
        )
      : undefined;
    if (pendingReplay?.id)
      return ok({
        ...base,
        action: "fix",
        objective:
          "Replay the recorded input on the current implementation before deciding on further repair or review; the retained failure remains unresolved",
        command: replayCommand(record.brief.feature, pendingReplay.id, slice.id),
        evidence: currentJourneyFailures(record, subject, slice.id),
        mayEdit: true,
        completion: "unresolved-product",
      });
    return ok({
      ...base,
      action: "fix",
      objective:
        "Inspect the failed journey and terminal state. Correct the behavior, or explicitly resolve a mistaken exploratory expectation with current replacement observations; preserve the promised outcome.",
      command: `visp review --handoff --feature ${record.brief.feature} --task ${slice.id}`,
      evidence: currentJourneyFailures(record, subject, slice.id),
      mayEdit: true,
      completion: "unresolved-product",
    });
  }
}

function hasRequiredSliceFeedback(record: ProductRecord, slice: ProductSlice) {
  return outstandingFeedback(record).some(
    (finding) => finding.required && findingAppliesToSlice(finding, slice),
  );
}

function sliceReviewCommand(record: ProductRecord, slice: ProductSlice, exhausted: boolean) {
  return !exhausted && hasRequiredSliceFeedback(record, slice)
    ? `visp work --feature ${record.brief.feature} --task ${slice.id}`
    : `visp review --handoff --feature ${record.brief.feature} --task ${slice.id}`;
}
