import { needsBrowser } from "./environment.js";
import { evidenceApplies, productCaptureRunSchema } from "./evidence-references.js";
import type { ProductSlice } from "./model.js";
import { OBSERVATION_REVIEW_INSTRUCTIONS, observationSequence } from "./observation-preview.js";
import type { ProductRecord } from "./store.js";
import { productContractDigest } from "./subject.js";

/** Schedule a judgment of the first rendered slice; captures alone never close it. */
export function visualCheckpoint(
  record: ProductRecord,
  subject: string,
  slice?: ProductSlice,
  reviewMode: "current" | "observation-preview" = "current",
) {
  if (!needsBrowser(record.brief, slice)) return undefined;
  const outcomes = record.brief.outcomes.filter(
    (outcome) => outcome.kind === "experience" && (!slice || slice.outcomes.includes(outcome.id)),
  );
  if (!outcomes.length) return undefined;
  const runs = record.state.captureRuns.flatMap((candidate) => {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    return parsed.success &&
      evidenceApplies(record, subject, parsed.data) &&
      (!slice || !parsed.data.task || parsed.data.task === slice.id)
      ? [parsed.data]
      : [];
  });
  const review = record.state.reviews.findLast(
    (entry) =>
      entry.subjectDigest === subject &&
      (!slice || !entry.task || entry.task === slice.id) &&
      entry.contractDigest ===
        productContractDigest(
          record.brief,
          record.brief.slices.find((owner) => owner.id === entry.task),
        ) &&
      entry.feedback?.phase === "product" &&
      (entry.feedback.dimensions.some((dimension) => dimension.dimension === "experience") ||
        entry.assessments.some((assessment) =>
          outcomes.some((outcome) => outcome.id === assessment.outcome),
        )),
  );
  const assessment = review?.feedback?.dimensions.find((entry) => entry.dimension === "experience");
  const direct =
    review?.assessments.filter((entry) =>
      outcomes.some((outcome) => outcome.id === entry.outcome),
    ) ?? [];
  const satisfied = direct.length
    ? outcomes.every((outcome) =>
        direct.some(
          (entry) =>
            entry.outcome === outcome.id &&
            entry.status === "satisfied" &&
            entry.expectations.every((expectation) => expectation.status === "satisfied"),
        ),
      )
    : assessment?.status === "satisfied";
  const captures = runs.flatMap((run) => run.captures);
  const repeated = runs.length >= 3 && !satisfied;
  const sequence =
    reviewMode === "observation-preview" ? observationSequence(record, subject, slice) : undefined;
  return {
    status: !captures.length ? "awaiting-render" : satisfied ? "assessed" : "review-rendered-slice",
    originalRequest: record.brief.originalRequest,
    outcomes: outcomes.map(({ id, statement }) => ({ id, statement })),
    timing:
      "Inspect the first usable rendered slice before expanding content. Revisit after consequential visual changes; no forced cosmetic edits or extra critic calls.",
    images: [
      ...new Map(
        captures.map((capture) => [
          `${capture.viewport.width}x${capture.viewport.height}`,
          capture,
        ]),
      ).values(),
    ]
      .slice(0, 4)
      .map(({ id, path, viewport }) => ({ id, path, viewport })),
    ...(sequence
      ? {
          reviewMode,
          observationSequence: sequence,
          images: sequence.states.map((state) => {
            const capture = captures.find((capture) => capture.id === state.id);
            return { ...state, path: capture?.path };
          }),
          observationInstructions: OBSERVATION_REVIEW_INSTRUCTIONS,
        }
      : {}),
    imageStatus:
      "Recorded references only; review handoff verifies and delivers the actual image bytes. Missing, stale or unviewed images cannot establish quality.",
    command: `visp review --feature ${record.brief.feature}${slice ? ` --task ${slice.id}` : ""} --handoff`,
    assess:
      "Judge the actual primary activity at each viewport: usable scale, scene composition, hierarchy, contrast, expressive assets/materials and intermediate feedback. Matching the worker's palette or theme is not aesthetic success. A UI can be readable yet visually weak. Give zero to three consequential findings with a concrete visible change and next observation, or explain why the requested experience is already achieved. Use the existing feedback fields.",
    ...(repeated
      ? {
          recovery:
            "Repeated captures of this source have not produced a satisfied visual assessment. Diagnose any evidence/host gap once; then inspect the rendered product and address the most consequential visible mismatch. Editing observation attributes or check descriptions is not visual refinement. If no reviewer is available, report that gap instead of repeating capture or inventing approval.",
        }
      : {}),
  };
}
