import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { ProductReviewImage } from "../evidence/product-review.js";

import type { WorkspaceState } from "../state.js";
import type { productReviewImageGroups } from "./image-groups.js";
import { captureSchema, inspectProductImages } from "./images.js";
import { assessmentSchema, type ProductOutcome, type ProductSlice } from "./model.js";
import { observationSequence } from "./observation-preview.js";
import { reproductionContextDigest } from "./reproduction-bindings.js";
import type { ProductReviewOptions } from "./review.js";
import { preferredReviewCaptures } from "./review-context.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

/** A bounded, reproducible selection, not authentication of a reviewer or proof of image viewing. */
export const reviewSelectionSchema = z
  .object({
    version: z.literal(1),
    feature: z.string().min(1),
    task: z.string().optional(),
    subjectDigest: z.string().min(1),
    contractDigest: z.string().min(1),
    reproductionDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    images: z
      .array(
        z.object({ id: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
      )
      .max(6),
  })
  .strict();
export type ReviewSelection = z.infer<typeof reviewSelectionSchema>;

export function validateReviewSelection(
  input: unknown,
  current: Omit<ReviewSelection, "version" | "images">,
): Result<ReviewSelection | undefined> {
  if (input === undefined) return ok(undefined);
  const parsed = reviewSelectionSchema.safeParse(input);
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Invalid review selection: ${parsed.error.message}`));
  const selection = parsed.data;
  if (
    selection.feature !== current.feature ||
    selection.task !== current.task ||
    selection.subjectDigest !== current.subjectDigest ||
    selection.contractDigest !== current.contractDigest ||
    selection.reproductionDigest !== current.reproductionDigest
  )
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Review context changed; refresh --template with the same --feature and --task scope used for submission (omit --task for assembled-product review). Inspect the current slice and brief before fresh judgments. Use --from - or .visp/drafts; product-tree review files change the subject",
        { recovery: "visp review --template" },
      ),
    );
  return ok(selection);
}

export function validateSelectedImages(
  selection: ReviewSelection | undefined,
  images: readonly ProductReviewImage[],
): Result<void> {
  const missing =
    selection?.images.filter(
      (entry) => !images.some((image) => image.id === entry.id && image.sha256 === entry.sha256),
    ) ?? [];
  return missing.length
    ? err(
        vispError(
          "EVIDENCE_FAILED",
          `Selected review images are no longer available: ${missing.map((entry) => entry.id).join(", ")}; refresh the review context`,
        ),
      )
    : ok(undefined);
}

export async function inspectSelectedImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductReviewOptions,
  subject: string,
  slice: ProductSlice | undefined,
  captures: unknown[],
  imageGroups: ReturnType<typeof productReviewImageGroups>,
) {
  const selection = validateReviewSelection(options.selection, {
    feature: record.brief.feature,
    task: slice?.id,
    subjectDigest: subject,
    contractDigest: productContractDigest(record.brief, slice),
    reproductionDigest: reproductionContextDigest(record),
  });
  if (!selection.ok) return selection;
  const images = await inspectProductImages(
    workspace,
    subject,
    captures,
    [
      ...(selection.value?.images.map((entry) => entry.id) ?? []),
      ...reviewImageReferences(options, record, subject, slice, imageGroups.length > 0),
    ],
    imageGroups,
    selection.value?.images.map((entry) => entry.id) ??
      (workspace.config.workflow.reviewMode === "observation-preview" && !options.groups?.length
        ? observationSequence(record, subject, slice).states.map((entry) => entry.id)
        : undefined),
  );
  const selectedImages = validateSelectedImages(selection.value, images.images);
  if (!selectedImages.ok) return selectedImages;
  return ok(images);
}

export function reviewImageGaps(
  outcomes: readonly ProductOutcome[],
  gaps: readonly string[],
  hasCaptures: boolean,
) {
  return hasCaptures ||
    outcomes.some(
      (outcome) =>
        outcome.kind === "experience" ||
        outcome.expectations.some((expectation) => expectation.viewport),
    )
    ? gaps
    : [];
}

function reviewImageReferences(
  options: ProductReviewOptions,
  record: ProductRecord,
  subject: string,
  slice: ProductSlice | undefined,
  grouped: boolean,
) {
  return [
    ...(options.groups ?? []),
    ...submittedCaptureReferences(options.assessments),
    ...coverageCaptureReferences(options.coverage),
    ...feedbackCaptureReferences(options.feedback),
    ...coverageCaptureReferences(options.experimentResolutions),
    ...(grouped ? [] : preferredReviewCaptures(record, subject, slice)),
  ];
}

function feedbackCaptureReferences(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  return ["dimensions", "findings", "resolutions", "probes"].flatMap((key) =>
    coverageCaptureReferences((input as Record<string, unknown>)[key]),
  );
}

export function suppliedCaptures(input: unknown): Result<unknown[]> {
  if (input === undefined) return ok([]);
  const parsed = z.array(captureSchema).safeParse(input);
  return parsed.success
    ? ok(parsed.data.map((capture) => ({ ...capture, provenance: "agent-supplied" as const })))
    : err(vispError("ARTIFACT_INVALID", `Invalid review captures: ${parsed.error.message}`));
}

function submittedCaptureReferences(input: unknown): string[] {
  const parsed = z.array(assessmentSchema).safeParse(input);
  return parsed.success
    ? parsed.data.flatMap((assessment) => [
        ...assessment.evidence,
        ...assessment.expectations.flatMap((expectation) => expectation.evidence ?? []),
      ])
    : [];
}

function coverageCaptureReferences(input: unknown): string[] {
  return Array.isArray(input)
    ? input.flatMap((entry) =>
        entry && typeof entry === "object" && Array.isArray(entry.evidence)
          ? entry.evidence.filter((id: unknown): id is string => typeof id === "string")
          : [],
      )
    : [];
}
