import { applicableReviews } from "./assessment.js";
import { currentProductFailures } from "./corrections.js";
import { currentJourneyFailures } from "./evidence-references.js";
import { outstandingFeedback } from "./feedback.js";
import { PRODUCT_REVIEW_POLICY, type ProductAssessment, type ProductOutcome } from "./model.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";
import { legacyFeatureContractDigest, productContractDigest } from "./subject.js";

export interface ProductIdentity {
  subject: string;
  implementation: string;
}

export function historicalAcceptanceNext(
  record: ProductRecord,
  identity: ProductIdentity,
  base: { feature: string; task?: string },
): ProductNext | undefined {
  if (
    record.state.status !== "accepted" ||
    record.state.acceptedReviewPolicy === PRODUCT_REVIEW_POLICY ||
    (record.state.acceptedContract !== productContractDigest(record.brief) &&
      record.state.acceptedContract !== legacyFeatureContractDigest(record.brief)) ||
    currentProductFailures(record, identity.subject).length ||
    currentJourneyFailures(record, identity.subject).length ||
    currentReviewContradictsHistoricalAcceptance(record, identity.subject) ||
    outstandingFeedback(record).some((entry) => entry.required) ||
    applicableReviews(record, identity.subject).some((review) =>
      review.feedback?.dimensions.some(
        (entry) => !["satisfied", "not-applicable"].includes(entry.status),
      ),
    )
  )
    return undefined;
  const accepted = record.state.reviews.findLast(
    (review) =>
      review.subjectDigest === record.state.acceptedSubject &&
      review.implementationDigest !== undefined,
  );
  if (
    record.state.acceptedSubject === identity.subject ||
    accepted?.implementationDigest === identity.implementation
  ) {
    const historicalGaps = legacyReviewContradictions(record, identity);
    if (historicalGaps.length)
      return {
        ...base,
        action: "refine",
        objective:
          "Resolve the retained review mismatch against the current product before relying on historical acceptance",
        command: `visp review --handoff --feature ${record.brief.feature}`,
        evidence: historicalGaps,
        mayEdit: false,
      };
    return {
      ...base,
      action: "complete",
      objective:
        "Historically accepted under the previous review policy; original evidence is preserved",
      evidence: ["This does not claim validation under the current coverage review policy"],
      mayEdit: false,
    };
  }
  if (!accepted?.implementationDigest)
    return {
      ...base,
      action: "understand",
      objective:
        "Historical acceptance is preserved; current implementation freshness is unknown under the upgraded runtime",
      command: `visp review --handoff --feature ${record.brief.feature}`,
      evidence: [
        "The old acceptance has no implementation-only identity. Explicit new acceptance requires current evidence.",
      ],
      mayEdit: false,
    };
  return undefined;
}

function currentReviewContradictsHistoricalAcceptance(record: ProductRecord, subject: string) {
  const latest = new Map(
    applicableReviews(record, subject)
      .filter((review) => (review.policyVersion ?? 0) >= 2)
      .flatMap((review) =>
        review.assessments.map(
          (assessment) => [JSON.stringify([assessment.outcome, review.task]), assessment] as const,
        ),
      ),
  );
  return [...latest.values()].some((assessment) => {
    const outcome = record.brief.outcomes.find((entry) => entry.id === assessment.outcome);
    return outcome?.priority === "must" && unresolvedAssessment(outcome, assessment);
  });
}

/** Legacy positives never supply fresh credit or clear a retained mismatch. */
function legacyReviewContradictions(record: ProductRecord, identity: ProductIdentity): string[] {
  const legacy = legacyFeatureContractDigest(record.brief);
  const current = new Set(applicableReviews(record, identity.subject));
  const pending = new Map<string, string>();
  const reviews = record.state.reviews.filter(
    (review) =>
      (review.policyVersion ?? 0) >= 2 &&
      (current.has(review) ||
        (!review.task &&
          review.contractDigest === legacy &&
          (review.subjectDigest === identity.subject ||
            review.implementationDigest === identity.implementation))),
  );
  for (const review of reviews) {
    if (current.has(review)) {
      clearRetainedByFeatureReview(pending, review);
      continue;
    }
    for (const assessment of review.assessments) {
      const outcome = record.brief.outcomes.find((entry) => entry.id === assessment.outcome);
      if (outcome?.priority === "must" && unresolvedAssessment(outcome, assessment))
        pending.set(
          outcome.id,
          `${outcome.id}: retained earlier-policy ${assessment.status} judgment: ${assessment.summary}`,
        );
    }
  }
  return [...pending.values()];
}

function clearRetainedByFeatureReview(
  pending: Map<string, string>,
  review: ProductRecord["state"]["reviews"][number],
) {
  if (review.task) return;
  for (const assessment of review.assessments) pending.delete(assessment.outcome);
}

function unresolvedAssessment(outcome: ProductOutcome, assessment: ProductAssessment): boolean {
  return (
    assessment.status !== "satisfied" ||
    outcome.expectations.some(
      (expectation) =>
        assessment.expectations.find((entry) => entry.id === expectation.id)?.status !==
        "satisfied",
    )
  );
}
