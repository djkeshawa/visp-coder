import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { productJourneyGaps, productJourneyImageLinks } from "../evidence/product-journey.js";
import type { ProductReviewImage } from "../evidence/product-review.js";
import {
  evidenceSupportGaps,
  type ProductEvidenceCatalogue,
  resolveAssessmentEvidence,
} from "./evidence-references.js";
import { assessmentSchema, type ProductAssessment, type ProductOutcome } from "./model.js";
import type { ProductReviewOptions } from "./review.js";

export function validateAssessments(
  options: ProductReviewOptions,
  subject: string,
  outcomes: readonly ProductOutcome[],
  images: readonly ProductReviewImage[],
  captureRuns: (outcome: string) => readonly unknown[],
  catalogue: ProductEvidenceCatalogue,
): Result<ProductAssessment[]> {
  if (options.subjectDigest !== subject)
    return err(
      vispError(
        "EVIDENCE_FAILED",
        "Review subject is missing or stale; inspect the current review bundle first. Submit via --from - or store drafts in .visp/drafts; creating or editing a review file in the product tree changes the subject",
        { recovery: "visp review --json" },
      ),
    );
  const parsed = z.array(assessmentSchema).safeParse(options.assessments);
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Invalid assessments: ${parsed.error.message}`));
  if (
    new Set(parsed.data.map((entry) => entry.outcome)).size !== parsed.data.length ||
    parsed.data.some((entry) => !outcomes.some((outcome) => outcome.id === entry.outcome))
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Assessments must name distinct outcomes in the selected scope",
      ),
    );
  for (const assessment of parsed.data) {
    const outcome = outcomes.find((entry) => entry.id === assessment.outcome);
    const suppliedIds = assessment.expectations.map((entry) => entry.id);
    if (
      new Set(suppliedIds).size !== suppliedIds.length ||
      suppliedIds.some((id) => !outcome?.expectations.some((entry) => entry.id === id))
    )
      return err(
        vispError(
          "ARTIFACT_INVALID",
          "Expectation assessments must name distinct expectations in their outcome",
        ),
      );
  }
  const assessments: ProductAssessment[] = [];
  for (const assessment of parsed.data) {
    const resolved = resolveAssessmentEvidence(assessment, catalogue);
    if (!resolved.ok) return resolved;
    const runs = captureRuns(assessment.outcome);
    const linked = linkExecutionImages(resolved.value, subject, images, runs, catalogue);
    const supported = assessEvidenceSupport(linked, outcomes, catalogue);
    assessments.push(assessImageLink(supported, outcomes, images, subject, runs));
  }
  return ok(assessments);
}

/** Derive bookkeeping from cited execution, without supplying or changing any judgment. */
function linkExecutionImages(
  assessment: ProductAssessment,
  subjectDigest: string,
  images: readonly ProductReviewImage[],
  captureRuns: readonly unknown[],
  catalogue: ProductEvidenceCatalogue,
): ProductAssessment {
  const executions = catalogue.entries.filter(
    (entry) =>
      entry.kind === "execution" &&
      entry.status === "available" &&
      entry.captureRunId &&
      (!entry.outcomes.length || entry.outcomes.includes(assessment.outcome)),
  );
  const available = new Set(
    catalogue.entries
      .filter((entry) => entry.kind === "image" && entry.status === "available")
      .map((entry) => entry.id),
  );
  const selectedImages = images.filter((image) => available.has(image.id));
  const link = (references: readonly string[]) => {
    const runIds = new Set(
      executions.flatMap((entry) =>
        references.includes(entry.id) && entry.captureRunId ? [entry.captureRunId] : [],
      ),
    );
    const links = productJourneyImageLinks({
      subjectDigest,
      captureRuns,
      runIds,
      images: selectedImages,
    });
    return [...new Set([...references, ...links])];
  };
  return {
    ...assessment,
    evidence: link(assessment.evidence),
    expectations: assessment.expectations.map((entry) => ({
      ...entry,
      evidence: link(entry.evidence ?? assessment.evidence),
    })),
  };
}

function assessEvidenceSupport(
  assessment: ProductAssessment,
  outcomes: readonly ProductOutcome[],
  catalogue: ProductEvidenceCatalogue,
): ProductAssessment {
  const expectations = assessExpectationSupport(assessment, outcomes, catalogue);
  const refs = [...assessment.evidence, ...expectations.flatMap((entry) => entry.evidence ?? [])];
  const gaps =
    assessment.status === "satisfied"
      ? evidenceSupportGaps(
          refs,
          catalogue,
          assessment.outcome,
          outcomes.find((entry) => entry.id === assessment.outcome)?.kind === "functional",
        )
      : [];
  if (assessment.status === "satisfied")
    gaps.push(...expectationGaps(assessment, outcomes, expectations));
  const failed =
    assessment.status === "failed" || expectations.some((entry) => entry.status === "failed");
  return {
    ...assessment,
    expectations,
    ...(gaps.length
      ? {
          status: failed ? ("failed" as const) : ("unavailable" as const),
          summary: `${assessment.summary}\n${gaps.join("\n")}`,
        }
      : {}),
  };
}

function expectationGaps(
  assessment: ProductAssessment,
  outcomes: readonly ProductOutcome[],
  expectations: ProductAssessment["expectations"],
) {
  const gaps = expectations
    .filter((entry) => entry.status !== "satisfied")
    .map((entry) => `${entry.id}: ${entry.status}: ${entry.reason}`);
  const outcome = outcomes.find((entry) => entry.id === assessment.outcome);
  if (outcome?.priority === "must")
    for (const required of outcome.expectations)
      if (!expectations.some((entry) => entry.id === required.id))
        gaps.push(`${required.id}: mandatory expectation is unassessed`);
  return gaps;
}

function assessExpectationSupport(
  assessment: ProductAssessment,
  outcomes: readonly ProductOutcome[],
  catalogue: ProductEvidenceCatalogue,
): ProductAssessment["expectations"] {
  return assessment.expectations.map((expectation) => {
    if (expectation.status !== "satisfied") return expectation;
    const gaps = evidenceSupportGaps(
      expectation.evidence ?? assessment.evidence,
      catalogue,
      assessment.outcome,
      outcomes.find((entry) => entry.id === assessment.outcome)?.kind === "functional",
    );
    const required = outcomes
      .find((entry) => entry.id === assessment.outcome)
      ?.expectations.find((entry) => entry.id === expectation.id)?.viewport;
    if (
      required &&
      !catalogue.entries.some(
        (entry) =>
          expectation.evidence?.includes(entry.id) &&
          entry.status === "available" &&
          entry.viewport?.width === required.width &&
          entry.viewport.height === required.height,
      )
    )
      gaps.push(
        `No linked observation at the promised ${required.width}×${required.height} viewport`,
      );
    return gaps.length
      ? {
          ...expectation,
          status: "unavailable" as const,
          reason: `${expectation.reason}\n${gaps.join("\n")}`,
        }
      : expectation;
  });
}

function assessImageLink(
  assessment: ProductAssessment,
  outcomes: readonly ProductOutcome[],
  images: readonly ProductReviewImage[],
  subjectDigest: string,
  captureRuns: readonly unknown[],
): ProductAssessment {
  const outcome = outcomes.find((entry) => entry.id === assessment.outcome);
  const requiresImage = outcome?.kind === "experience";
  const hasImage = images.some(
    (image) => assessment.evidence.includes(image.id) || assessment.evidence.includes(image.path),
  );
  if (assessment.status !== "satisfied" || !requiresImage) return assessment;
  const journey =
    outcome?.priority === "must"
      ? productJourneyGaps({
          subjectDigest,
          captureRuns,
          images,
          linkedEvidence: assessment.evidence,
        })
      : [];
  const gaps = [
    ...(!hasImage ? ["No intact current image was linked to this assessment."] : []),
    ...journey,
  ];
  if (gaps.length)
    return {
      ...assessment,
      status: "unavailable",
      summary: `${assessment.summary}\n${gaps.join("\n")}`,
    };
  return assessment;
}
