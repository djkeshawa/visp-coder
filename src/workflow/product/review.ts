import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { ProductReviewImage } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { applicableReviews } from "./assessment.js";
import { reviewCodeSources } from "./code-context.js";
import {
  currentCoverage,
  type ProductReviewChallenge,
  productReviewChallenges,
} from "./coverage.js";
import { type ProductEvidenceReference, productEvidenceCatalogue } from "./evidence-references.js";
import type { experimentReviewContext } from "./experiments.js";
import type { productFeedbackPlan } from "./feedback.js";
import { productReviewImageGroups } from "./image-groups.js";
import type { DeliveredProductImageGroup } from "./images.js";
import {
  closedSlice,
  type PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductCoverageAssessment,
  type ProductExecution,
  type ProductOutcome,
  type ProductReviewerContext,
  type ProductSlice,
  reviewerContextSchema,
} from "./model.js";
import type { observationSequence } from "./observation-preview.js";
import { assembleReviewBundle } from "./review-bundle.js";
import {
  previousReviewAssessments,
  type productReviewAgenda,
  type reviewInteractionEvidence,
} from "./review-context.js";
import type { ProductReviewRecurrence } from "./review-recurrence.js";
import {
  inspectSelectedImages,
  type ReviewSelection,
  reviewImageGaps,
  suppliedCaptures,
} from "./review-selection.js";
import { submitReview } from "./review-submission.js";
import { withProductMutation } from "./runtime.js";
import { selectProductSlice } from "./scopes.js";
import type { ProductSource, sourceClaims } from "./sources.js";
import { type ProductRecord, type ProductSelection, readProductRecord } from "./store.js";
import {
  productContractDigest,
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "./subject.js";

export interface ProductReviewOptions extends ProductSelection {
  readonly subjectDigest?: string;
  readonly assessments?: unknown;
  readonly captures?: unknown;
  readonly coverage?: unknown;
  readonly reviewer?: unknown;
  readonly groups?: readonly string[];
  readonly feedback?: unknown;
  readonly selection?: unknown;
  readonly experimentResolutions?: unknown;
}
export interface ProductReviewBundle {
  readonly observationSequence?: ReturnType<typeof observationSequence>;
  readonly policyVersion: typeof PRODUCT_REVIEW_POLICY;
  readonly feedbackPlan: ReturnType<typeof productFeedbackPlan>;
  readonly feature: string;
  readonly task?: string;
  readonly subjectDigest: string;
  readonly selection: ReviewSelection;
  readonly originalRequest: string;
  readonly outcomes: readonly ProductOutcome[];
  readonly executions: readonly ProductExecution[];
  readonly controls: readonly unknown[];
  readonly captureRuns: readonly unknown[];
  readonly previousAssessments: readonly {
    subjectDigest: string;
    current: boolean;
    assessments: readonly ProductAssessment[];
  }[];
  readonly assessments: readonly ProductAssessment[];
  readonly images: readonly ProductReviewImage[];
  readonly gaps: readonly string[];
  readonly agenda: ReturnType<typeof productReviewAgenda>;
  readonly interactionEvidence: ReturnType<typeof reviewInteractionEvidence>;
  readonly experiments: ReturnType<typeof experimentReviewContext>;
  readonly evidence: readonly ProductEvidenceReference[];
  readonly evidenceOmitted: number;
  readonly sources: readonly ProductSource[];
  readonly sourceClaims: ReturnType<typeof sourceClaims>;
  readonly findings: readonly ProductAssessment[];
  readonly refinement: {
    readonly limit: number;
    readonly used: number;
    readonly remaining: number;
    readonly maximumFindings: 3;
    readonly exhausted: boolean;
  };
  readonly reviewerInstructions: string;
  readonly challenges: readonly ProductReviewChallenge[];
  readonly challengesOmitted: number;
  readonly coverageRemaining: number;
  readonly coverage: readonly ProductCoverageAssessment[];
  readonly imageGroups: readonly DeliveredProductImageGroup[];
  readonly imageGroupsOmitted: number;
  readonly reviewer: ProductReviewerContext;
  readonly recurrence: readonly ProductReviewRecurrence[];
}

export function runProductReview(
  workspace: WorkspaceState,
  options: ProductReviewOptions = {},
): Promise<Result<ProductReviewBundle>> {
  return options.assessments === undefined
    ? review(workspace, options)
    : withProductMutation(workspace, () => review(workspace, options));
}

async function review(
  workspace: WorkspaceState,
  options: ProductReviewOptions,
): Promise<Result<ProductReviewBundle>> {
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return loaded;
  let record = loaded.value;
  const selected = selectProductSlice(workspace, record, options);
  if (!selected.ok) return selected;
  const slice = reviewSlice(record, selected.value, options.task);
  const snapshot = await productSourceSnapshot(workspace, record.brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, record.brief, snapshot.value);
  if (!subject.ok) return subject;
  const contractDigest = productContractDigest(record.brief, slice);
  const implementationDigest = productImplementationDigest(workspace, snapshot.value);
  const previous = previousReviewAssessments(record, subject.value, slice);
  const latest = applicableReviews(record, subject.value)
    .filter((entry) => entry.task === slice?.id)
    .at(-1);
  const captures = [...record.state.captures, ...(latest?.captures ?? [])];
  const supplied = suppliedCaptures(options.captures);
  if (!supplied.ok) return supplied;
  captures.push(...supplied.value);
  const imageGroups = productReviewImageGroups(record, subject.value, slice);
  if (options.groups?.some((id) => !imageGroups.some((group) => group.id === id)))
    return err(
      vispError("ARTIFACT_INVALID", "Unknown image group; select a current group from visp review"),
    );
  const inspected = await inspectSelectedImages(
    workspace,
    record,
    options,
    subject.value,
    slice,
    captures,
    imageGroups,
  );
  if (!inspected.ok) return inspected;
  const images = inspected.value;
  let assessments = [
    ...new Map(
      applicableReviews(record, subject.value, slice).flatMap((review) =>
        review.assessments.map((entry) => [entry.outcome, entry] as const),
      ),
    ).values(),
  ].filter((entry) => !slice || slice.outcomes.includes(entry.outcome));
  const previousCurrent = assessments;
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  const codeSources = await reviewCodeSources(workspace, record, snapshot.value);
  const catalogue = await productEvidenceCatalogue(
    workspace,
    record,
    subject.value,
    images.images,
    images.availability,
    codeSources,
    slice,
  );
  const gaps = [...reviewImageGaps(outcomes, images.gaps, captures.length > 0)];
  const challenges = productReviewChallenges(record, slice);
  let coverage = currentCoverage(record, subject.value);
  const reviewer = reviewerContextSchema.safeParse({
    ...(reviewerInput(options, latest?.reviewer) as object),
    reviewMode: workspace.config.workflow.reviewMode,
  });
  if (!reviewer.success)
    return err(
      vispError("ARTIFACT_INVALID", `Invalid reviewer context: ${reviewer.error.message}`),
    );
  if (options.assessments !== undefined) {
    const submitted = await submitReview({
      workspace,
      record,
      slice,
      options,
      subject: subject.value,
      implementation: implementationDigest,
      contractDigest,
      images: images.images,
      catalogue,
      challenges,
      coverage,
      previous: previousCurrent,
      reviewer: reviewer.data,
    });
    if (!submitted.ok) return submitted;
    record = submitted.value.record;
    coverage = submitted.value.coverage;
    assessments = [
      ...new Map(
        [...previousCurrent, ...submitted.value.assessments].map((entry) => [entry.outcome, entry]),
      ).values(),
    ];
  }
  return ok(
    assembleReviewBundle({
      workspace,
      record,
      slice,
      subject: subject.value,
      contractDigest,
      implementationDigest,
      previous,
      outcomes,
      assessments,
      images,
      catalogue,
      gaps,
      challenges,
      coverage,
      reviewer: reviewer.data,
    }),
  );
}

function reviewerInput(options: ProductReviewOptions, previous?: ProductReviewerContext) {
  return (
    options.reviewer ??
    (options.assessments === undefined ? previous : undefined) ?? { context: "unspecified" }
  );
}

function reviewSlice(
  record: ProductRecord,
  selected: ProductSlice | undefined,
  explicit?: string,
): ProductSlice | undefined {
  if (explicit !== undefined) return selected;
  return record.brief.slices.every((entry) => closedSlice(record.state.slices[entry.id]?.status))
    ? undefined
    : selected;
}
