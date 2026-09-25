import { ok } from "../../core/result.js";
import { reviewInputTemplate } from "../product-inputs.js";
import type { WorkspaceState } from "../state.js";
import { type ProductFeedback, QUALITY_DIMENSIONS } from "./feedback-model.js";
import { reviewerContextSchema } from "./model.js";
import { type ProductReviewBundle, type ProductReviewOptions, runProductReview } from "./review.js";

const findingExample: ProductFeedback["findings"][number] = {
  dimension: "functional",
  problem: "Describe an observed defect or unresolved evidence gap",
  nextCheck: "Describe the concrete exercise needed to verify a correction",
  outcomes: [],
  required: true,
  evidence: [],
};

/** The host owns reviewer dispatch and model selection; preparing a handoff never starts a model. */
export async function runProductReviewerHandoff(
  workspace: WorkspaceState,
  options: ProductReviewOptions = {},
) {
  const reviewed = await runProductReview(workspace, {
    feature: options.feature,
    task: options.task,
    groups: options.groups,
  });
  return reviewed.ok ? ok(productReviewerHandoff(reviewed.value)) : reviewed;
}

export function productReviewerHandoff(bundle: ProductReviewBundle) {
  return {
    ...productReviewerContext(bundle),
    submissionGuidance: `Return the completed submission to the implementing host. Use reviewer.context exactly as one of ${JSON.stringify(reviewerContextSchema.shape.context.options)}; put explanations in reviewer.reason. feedback.findings accepts at most three objects shaped like ${JSON.stringify(findingExample)}. Use real outcome/evidence IDs and a dimension from ${JSON.stringify(QUALITY_DIMENSIONS)}. Findings use problem/nextCheck/outcomes/required; assessments use outcome/status/summary. Do not copy the example as a finding.`,
    submission: reviewInputTemplate(bundle),
  };
}

/** Evidence delivery is shared; the caller chooses the matching submission contract. */
export function productReviewerContext(bundle: ProductReviewBundle) {
  return {
    ...(bundle.observationSequence
      ? {
          originalRequest: bundle.originalRequest,
          outcomes: bundle.outcomes,
          images: bundle.images,
          observationSequence: bundle.observationSequence,
        }
      : {}),
    kind: "product-review-request" as const,
    feature: bundle.feature,
    task: bundle.task,
    subjectDigest: bundle.subjectDigest,
    dispatch: {
      owner: "host" as const,
      context: "fresh-preferred" as const,
      model: "Use the host's configured model; do not silently choose a stronger model.",
      fallback:
        'If a fresh context is unavailable, use reviewer.context: "current". If images or review itself are unavailable, preserve that gap.',
      provenance: "Reviewer context is agent-reported, not authenticated independence.",
    },
    originalRequest: bundle.originalRequest,
    feedbackPlan: bundle.feedbackPlan,
    sources: bundle.sources,
    outcomes: bundle.outcomes,
    agenda: bundle.agenda,
    interactionEvidence: bundle.interactionEvidence,
    experiments: bundle.experiments,
    challenges: bundle.challenges,
    challengesOmitted: bundle.challengesOmitted,
    evidence: bundle.evidence,
    evidenceOmitted: bundle.evidenceOmitted,
    images: bundle.images,
    imageGroups: bundle.imageGroups,
    imageGroupsOmitted: bundle.imageGroupsOmitted,
    gaps: bundle.gaps,
    recurrence: bundle.recurrence,
    previousFindings: bundle.previousAssessments.flatMap((review) =>
      review.assessments
        .filter((assessment) => assessment.status !== "satisfied")
        .map((assessment) => ({
          ...assessment,
          subjectDigest: review.subjectDigest,
          current: review.current,
        })),
    ),
    instructions: bundle.reviewerInstructions,
  };
}

/** First-pass reviewer input contains facts and user intent, not the actor's assessment. */
export function independentReviewerContext(bundle: ReturnType<typeof productReviewerContext>) {
  return {
    kind: bundle.kind,
    feature: bundle.feature,
    task: bundle.task,
    subjectDigest: bundle.subjectDigest,
    originalRequest: bundle.originalRequest,
    instructions: bundle.instructions,
    outcomes: bundle.outcomes,
    examples: bundle.agenda.examples,
    examplesOmitted: bundle.agenda.omitted.examples,
    ...(bundle.observationSequence ? { observationSequence: bundle.observationSequence } : {}),
    images: bundle.images,
    sources: bundle.sources.filter((source) => source.kind !== "authored-brief"),
    interactionEvidence: {
      ...bundle.interactionEvidence,
      guidance:
        "Recorded operations show what was exercised; assess their actual results independently.",
    },
    evidence: bundle.evidence.filter((entry) => !entry.id.startsWith("BRIEF-")),
    gaps: independentReviewGaps(bundle.gaps),
    ...repairQuestions(bundle),
  };
}

/** Historical image identities do not help assess the current product; current gaps still do. */
export function independentReviewGaps(gaps: readonly string[]) {
  let historicalImages = 0;
  const current = gaps.filter((gap) => {
    if (/^CAP-[^:]+: capture describes a different product version$/.test(gap)) {
      historicalImages += 1;
      return false;
    }
    return !gap.startsWith("Refinement budget exhausted");
  });
  if (historicalImages)
    current.push(
      `${historicalImages} historical capture(s) describe a different product version and are excluded from current review. Individual records remain in visp review.`,
    );
  return current;
}

/** Follow-up questions retain failures without replaying approval history or the actor's diagnosis. */
function repairQuestions(bundle: ReturnType<typeof productReviewerContext>) {
  const pending = bundle.feedbackPlan.findings.filter((finding) => finding.phase === "product");
  if (!pending.length) return {};
  return {
    repairQuestions: pending.map(
      ({ id, problem, outcomes, nextCheck, recheck, reproductions }) => ({
        id,
        problem,
        outcomes,
        nextCheck,
        ...(reproductions.length ? { reproductions } : {}),
        ...(recheck ? { recheck } : {}),
      }),
    ),
    repairGuidance:
      "Assess the current product independently. Then check these unresolved reports against current evidence. For attached reproductions, assess the caller-reported relationship using the actual failure and tested subject; the original subject was not necessarily executed; a report can itself be mistaken. Resolve only a specifically checked correction or counterexample, citing fresh evidence. A generally positive assessment does not resolve a particular failure.",
  };
}
