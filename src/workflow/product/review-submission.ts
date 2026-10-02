import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { ProductReviewImage } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { applicableProductCaptureRuns } from "./assessment.js";
import {
  applyCoverageFailures,
  type ProductReviewChallenge,
  validateCoverage,
} from "./coverage.js";
import type { ProductEvidenceCatalogue } from "./evidence-references.js";
import type { ExperimentResolution } from "./experiment-model.js";
import { experimentReviewContext, validateExperimentResolutions } from "./experiments.js";
import { feedbackIntentDigest, validateProductFeedback } from "./feedback.js";
import type { ProductFeedback } from "./feedback-model.js";
import { independentSources } from "./independent-sources.js";
import {
  PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductCoverageAssessment,
  type ProductReviewerContext,
  type ProductSlice,
} from "./model.js";
import type { ProductReviewOptions } from "./review.js";
import { reviewEvidence } from "./review-bundle.js";
import { deliveredReviewEvidenceIds, reviewInteractionEvidence } from "./review-context.js";
import {
  type DeliveredReviewEvidence,
  generatedSourceReferences,
  reviewCitationGap,
} from "./review-delivery-validation.js";
import { deliveredSourceEvidence } from "./review-source-delivery.js";
import { validateAssessments } from "./review-validation.js";
import { type ProductRecord, saveProductState } from "./store.js";
import { productSourceDigest } from "./subject.js";

interface ReviewSubmissionContext {
  deliveredEvidence?: DeliveredReviewEvidence;
  workspace: WorkspaceState;
  record: ProductRecord;
  slice?: ProductSlice;
  options: ProductReviewOptions;
  subject: string;
  implementation: string;
  contractDigest: string;
  images: readonly ProductReviewImage[];
  catalogue: ProductEvidenceCatalogue;
  challenges: readonly ProductReviewChallenge[];
  coverage: readonly ProductCoverageAssessment[];
  previous: readonly ProductAssessment[];
  reviewer: ProductReviewerContext;
}

export async function submitReview(context: ReviewSubmissionContext) {
  const { workspace, record, slice, options, subject, images, challenges, reviewer } = context;
  const delivered = await submissionCatalogue(context);
  if (!delivered.ok) return delivered;
  const catalogue = delivered.value;
  const feedback = validateProductFeedback(options.feedback, record, catalogue, reviewer, slice);
  if (!feedback.ok) return feedback;
  const resolutions = validateExperimentResolutions(
    options.experimentResolutions,
    record,
    subject,
    slice,
    catalogue,
  );
  if (!resolutions.ok) return resolutions;
  if (resolutions.value.length && !["current", "fresh"].includes(reviewer.context))
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Resolving an experimental expectation requires an available reviewer; provenance remains agent-reported",
      ),
    );
  const functionalOutcomes = new Set(
    record.brief.outcomes
      .filter((outcome) => outcome.kind === "functional")
      .map((outcome) => outcome.id),
  );
  const observed = validateCoverage(options.coverage, challenges, catalogue, functionalOutcomes);
  if (!observed.ok) return observed;
  const submittedCoverage =
    reviewer.context === "unavailable"
      ? observed.value.map((entry) =>
          entry.status === "failed"
            ? entry
            : {
                ...entry,
                status: "unavailable" as const,
                reason: `${entry.reason}\nReviewer unavailable: ${reviewer.reason ?? "Host could not assess the product"}`,
              },
        )
      : observed.value;
  const coverage = [
    ...new Map(
      [...context.coverage, ...submittedCoverage].map((entry) => [entry.id, entry]),
    ).values(),
  ];
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  const validated = validateAssessments(
    options,
    subject,
    outcomes,
    images,
    (outcome) => applicableProductCaptureRuns(record, subject, outcome),
    catalogue,
  );
  if (!validated.ok) return validated;
  const parents = missingFailedParents(
    validated.value,
    context.previous,
    challenges,
    submittedCoverage,
  );
  let assessments = applyCoverageFailures([...validated.value, ...parents], challenges, coverage);
  if (reviewer.context === "unavailable")
    assessments = assessments.map((entry) =>
      entry.status === "failed"
        ? entry
        : {
            ...entry,
            status: "unavailable",
            summary: `${entry.summary}\nReviewer unavailable: ${reviewer.reason ?? "Host could not assess the product"}`,
          },
    );
  const saved = await publishReview(
    workspace,
    record,
    slice,
    subject,
    context.implementation,
    context.contractDigest,
    assessments,
    images,
    submittedCoverage,
    reviewer,
    feedback.value,
    resolutions.value,
  );
  return saved.ok ? ok({ record: saved.value, assessments, coverage }) : saved;
}

function missingFailedParents(
  assessments: readonly ProductAssessment[],
  previous: readonly ProductAssessment[],
  challenges: readonly ProductReviewChallenge[],
  coverage: readonly ProductCoverageAssessment[],
): ProductAssessment[] {
  const failed = new Set(
    coverage
      .filter((entry) => entry.status === "failed")
      .flatMap(
        (entry) => challenges.find((challenge) => challenge.id === entry.id)?.outcomes ?? [],
      ),
  );
  return [...failed]
    .filter((id) => !assessments.some((entry) => entry.outcome === id))
    .map(
      (outcome) =>
        previous.find((entry) => entry.outcome === outcome) ?? {
          outcome,
          status: "failed",
          provenance: "agent-reported",
          summary: "A retained behavior example failed",
          expectations: [],
          evidence: [],
        },
    );
}

async function publishReview(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subjectDigest: string,
  implementationDigest: string,
  contractDigest: string,
  assessments: ProductAssessment[],
  images: readonly ProductReviewImage[],
  coverage: ProductCoverageAssessment[],
  reviewer: ProductReviewerContext,
  feedback?: ProductFeedback,
  experimentResolutions: ExperimentResolution[] = [],
): Promise<Result<ProductRecord>> {
  const timestamp = new Date().toISOString();
  const next = {
    ...record.state,
    updatedAt: timestamp,
    reviews: [
      ...record.state.reviews,
      {
        policyVersion: PRODUCT_REVIEW_POLICY,
        findingIdentityVersion: 2 as const,
        subjectDigest,
        implementationDigest,
        contractDigest,
        task: slice?.id,
        createdAt: timestamp,
        assessments,
        coverage,
        reviewer,
        ...(experimentResolutions.length ? { experimentResolutions } : {}),
        ...(feedback ? { feedback, feedbackIntentDigest: feedbackIntentDigest(record.brief) } : {}),
        captures: images.map(({ data: _data, mimeType: _mimeType, ...capture }) => capture),
      },
    ],
  };
  const after = await productSourceDigest(workspace, record.brief);
  if (!after.ok) return after;
  if (after.value !== subjectDigest)
    return err(vispError("EVIDENCE_FAILED", "Product changed during review submission"));
  const last = record.state.reviews.at(-1);
  const candidate = next.reviews.at(-1);
  if (
    last &&
    candidate &&
    hashValue({ ...last, createdAt: undefined }) ===
      hashValue({ ...candidate, createdAt: undefined })
  )
    return ok(record);
  const saved = await saveProductState(workspace, record, next);
  return saved.ok ? ok({ ...record, state: next }) : saved;
}

async function submissionCatalogue(context: ReviewSubmissionContext) {
  const { workspace, options, record, subject, slice, catalogue, previous } = context;
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  // Manual submissions use the authored-brief handoff contract. Legacy attempts without
  // delivery metadata retain this fallback; actual deliveries never refit their packet here.
  if (context.deliveredEvidence)
    return validateDeliveredCatalogue(context, context.deliveredEvidence);
  const understanding =
    (options.feedback as { phase?: string } | undefined)?.phase === "understanding";
  const delivered = await independentSources(workspace, catalogue.sources, understanding, true);
  if (!delivered.ok) return delivered;
  const evidence = deliveredSourceEvidence(
    reviewEvidence(catalogue, previous, outcomes).entries,
    catalogue.sources,
    delivered.value,
  );
  const ids = deliveredReviewEvidenceIds(
    evidence,
    reviewInteractionEvidence(record, subject, slice),
    delivered.value,
    experimentReviewContext(record, subject, slice),
  );
  return validateDeliveredCatalogue(context, {
    ids,
    generatedReferences: generatedSourceReferences(delivered.value, catalogue.sources),
  });
}

function validateDeliveredCatalogue(
  context: ReviewSubmissionContext,
  delivered: DeliveredReviewEvidence,
) {
  const { options, catalogue } = context;
  const ids = new Set(delivered.ids);
  const known = new Set(catalogue.entries.map((entry) => entry.id));
  // Legacy aliases remain usable only when their target was actually delivered.
  const usable = [
    ...ids,
    ...[...catalogue.aliases].filter(([, target]) => ids.has(target)).map(([alias]) => alias),
  ];
  const gap = reviewCitationGap(
    {
      assessments: options.assessments,
      coverage: options.coverage,
      feedback: options.feedback,
      experimentResolutions: options.experimentResolutions,
    },
    usable,
  );
  if (gap) return err(vispError("EVIDENCE_FAILED", gap));
  return ok({
    ...catalogue,
    sources: catalogue.sources.filter((source) => ids.has(source.id)),
    entries: [
      ...catalogue.entries.filter((entry) => ids.has(entry.id)),
      ...delivered.generatedReferences.filter((entry) => ids.has(entry.id) && !known.has(entry.id)),
    ],
  });
}
