import { ok, type Result } from "../../core/result.js";
import { cliCommand } from "../next-action.js";
import type { WorkspaceState } from "../state.js";
import {
  finalProductAssessmentGaps,
  productEvidenceGaps,
  productImageEvidenceGaps,
} from "./assessment.js";
import {
  currentProductFailures,
  failedCheckOwners,
  reviewCorrectionOutcomes,
} from "./corrections.js";
import { reviewerHandoff } from "./critic/critic-capacity.js";
import { environmentNext } from "./environment.js";
import { currentFailedJourneys, currentJourneyFailures } from "./evidence-references.js";
import { requiredFindingOwner } from "./findings.js";
import { withNotObservedAdvice } from "./not-observed-advice.js";
import { productRefinement } from "./refinement.js";
import { unavailableClosedReviewerFindingsNext } from "./review/reviewer-findings-route.js";
import type { ProductNext } from "./status.js";
import { environmentJourneyNext } from "./status-next-journeys.js";
import { pinnedStep, stuckPinnedStep } from "./status-next-open.js";
import { exhaustedNext, type ReviewerState, reviewerState } from "./status-next-review.js";
import type { ProductRecord } from "./store.js";
import { pinnedRoute } from "./tester/pinned-disputes.js";

export async function nextClosedProduct(
  workspace: WorkspaceState,
  record: ProductRecord,
  subject: string,
): Promise<Result<ProductNext>> {
  const failures = currentProductFailures(record, subject);
  const environmentFailures = failures.filter(
    (entry) => entry.status === "environment-failed" || entry.status === "timed-out",
  );
  if (environmentFailures.length) {
    const stuck = await stuckPinnedStep(workspace, record, undefined, failures);
    if (stuck) return ok(stuck);
    return ok(
      environmentNext(
        record.brief.feature,
        undefined,
        environmentFailures.map((entry) => `${entry.check}: ${entry.output}`),
        "verify",
      ),
    );
  }
  if (!failures.length) {
    const environmentJourney = environmentJourneyNext(
      record,
      subject,
      currentFailedJourneys(record, subject),
    );
    if (environmentJourney) return ok(environmentJourney);
  }
  const journeys = currentJourneyFailures(record, subject);
  const reviewer = await reviewerState(workspace, record, subject);
  const route = await pinnedRoute(
    workspace,
    record.brief.feature,
    undefined,
    failures,
    "accept",
    record.state.executions,
    reviewer.capacity,
  );
  const gaps = [
    ...route.evidence,
    ...(await productEvidenceGaps(workspace, record, subject)),
    ...failures.map((execution) => `${execution.check}: ${execution.status}: ${execution.output}`),
  ];
  const assessmentGaps = finalProductAssessmentGaps(record, subject, undefined, reviewer.runs);
  const findingsNext = unavailableClosedReviewerFindingsNext(
    workspace,
    record,
    subject,
    reviewer.capacity,
  );
  if (findingsNext) return ok(findingsNext);
  if (route.override)
    return ok(pinnedStep(record.brief.feature, undefined, route, [...gaps, ...assessmentGaps]));
  const correction = closedProductCorrection(record, subject, failures);
  if (correction && productRefinement(record, correction).exhausted)
    return exhaustedNext(record, correction, [...gaps, ...assessmentGaps]);
  if (correction)
    return ok({
      feature: record.brief.feature,
      task: correction.id,
      action: "fix",
      objective:
        route.objective ??
        "Reopen the implicated slice and correct the current product finding or failed assembled check",
      command: cliCommand("work", { feature: record.brief.feature, task: correction.id }),
      evidence: [...gaps, ...assessmentGaps],
      mayEdit: false,
    });
  if (failures.length)
    return ok({
      feature: record.brief.feature,
      action: "understand",
      objective:
        route.objective ??
        "Resolve the current execution failure and select its focused correction scope. If no existing slice owns the failed check, link its outcome or code paths in the brief before reauthorizing.",
      command: cliCommand("brief", { feature: record.brief.feature }),
      evidence: [...gaps, ...assessmentGaps],
      mayEdit: false,
    });
  const refine =
    assessmentGaps.length > 0 ||
    journeys.length > 0 ||
    (await productImageEvidenceGaps(workspace, record, subject)).length > 0;
  return ok(
    withNotObservedAdvice(
      {
        feature: record.brief.feature,
        ...finalStep(record, refine, reviewer),
        evidence: [...gaps, ...assessmentGaps],
        mayEdit: false,
      },
      record,
      subject,
    ),
  );
}

function closedProductCorrection(
  record: ProductRecord,
  subject: string,
  failures: ReturnType<typeof currentProductFailures>,
) {
  return (
    record.brief.slices.find((slice) =>
      currentFailedJourneys(record, subject).some(
        (run) => run.task === slice.id && run.failure?.kind === "behavior",
      ),
    ) ??
    // A finding naming outcomes of several slices goes to one owner, never the first in order.
    requiredFindingOwner(record) ??
    record.brief.slices.find(
      (slice) => reviewCorrectionOutcomes(record, slice, subject).length > 0,
    ) ??
    failures
      .map((execution) => failedCheckOwners(record, execution))
      .find((owners) => owners.length === 1)?.[0]
  );
}

function finalStep(record: ProductRecord, refine: boolean, reviewer: ReviewerState) {
  const feature = record.brief.feature;
  if (!refine)
    return {
      action: "accept" as const,
      objective: "Run final checks against the assembled product and preserved expectations",
      command: cliCommand("accept", { feature }),
    };
  if (reviewer.runs && !reviewer.capacity.available)
    return reviewerHandoff(feature, reviewer.capacity, "assessment");
  return reviewer.runs
    ? {
        action: "refine" as const,
        objective:
          "Run visp accept; VISP's independent reviewer assesses the assembled product first",
        command: cliCommand("accept", { feature }),
      }
    : {
        action: "refine" as const,
        objective:
          "Review the assembled product against every mandatory outcome and retained expectation",
        command: cliCommand("review", { handoff: true, feature }),
      };
}
