import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { productInputTemplate } from "../product-inputs.js";
import { productReviewReceipt } from "../product-presentation.js";
import type { WorkspaceState } from "../state.js";
import { experimentResolutionsSchema } from "./experiment-model.js";
import { productFeedbackSchema } from "./feedback-model.js";
import type { ProductFeedbackHost } from "./host-feedback.js";
import { independentJudgments, independentReviewSchema } from "./independent-review.js";
import { assessmentSchema, coverageAssessmentSchema, reviewerContextSchema } from "./model.js";
import { type ProductReviewOptions, runProductReview } from "./review.js";
import { reviewSelectionSchema } from "./review-selection.js";
import { runProductReviewerHandoff } from "./reviewer-handoff.js";

export const reviewJudgmentsSchema = z
  .object({
    assessments: z.array(assessmentSchema),
    coverage: z.array(coverageAssessmentSchema).optional(),
    reviewer: reviewerContextSchema.optional(),
    feedback: productFeedbackSchema.optional(),
    experimentResolutions: experimentResolutionsSchema.optional(),
  })
  .strict();

export const productReviewSubmissionSchema = reviewJudgmentsSchema.extend({
  subjectDigest: z.string().min(1),
  captures: z.unknown().optional(),
  selection: reviewSelectionSchema.optional(),
});

/** File, stdin and native tool submissions share one judgment boundary and recovery. */
export function parseReviewSubmission(input: unknown, session?: string) {
  const independent = session ? independentReviewSchema.safeParse(input) : undefined;
  if (independent?.success) return ok(independentJudgments(independent.data, "product"));
  const parsed = (session ? reviewJudgmentsSchema : productReviewSubmissionSchema).safeParse(input);
  if (parsed.success) return ok(parsed.data);
  const independentInput =
    independent &&
    input !== null &&
    typeof input === "object" &&
    ["summary", "findings", "limitations", "resolutions"].some((key) => key in input);
  return err(
    vispError(
      "ARTIFACT_INVALID",
      independentInput
        ? `Invalid prepared independent review: ${independent.error.message}`
        : `${session ? "A prepared-session submission requires an assessments array and judgments only; omit subjectDigest, selection and captures" : "A review submission requires subjectDigest and an assessments array"}: ${parsed.error.message}`,
      {
        recovery: session
          ? "Edit the submission object from this session's packet.json and resubmit it with the same --session; keep its tool-owned identity unchanged."
          : "visp review --template",
      },
    ),
  );
}

export interface ProductReviewRequest extends ProductReviewOptions {
  readonly prepare?: boolean;
  readonly session?: string;
  readonly template?: boolean;
  readonly handoff?: boolean;
  readonly detail?: boolean;
  readonly dispatch?: boolean;
}

/** Shared public operation: CLI and MCP use identical modes, validation and receipt shapes. */
export async function runProductReviewRequest(
  workspace: WorkspaceState,
  options: ProductReviewRequest = {},
  host?: ProductFeedbackHost,
): Promise<Result<unknown>> {
  const valid = validateProductReviewRequest(options);
  if (!valid.ok) return valid;
  if (options.prepare || options.session) {
    const sessions = await import("./review-session.js");
    return options.prepare
      ? sessions.prepareReviewSession(workspace, options)
      : sessions.submitReviewSession(workspace, options);
  }
  if (options.dispatch) {
    const { runProductHostFeedback } = await import("./host-feedback.js");
    return runProductHostFeedback(workspace, host ?? { model: "host-configured" }, options);
  }
  if (options.template) return productInputTemplate(workspace, "review", options);
  if (options.handoff) return runProductReviewerHandoff(workspace, options);
  const result = await runProductReview(workspace, options);
  return result.ok && options.assessments !== undefined && !options.detail
    ? ok(productReviewReceipt(result.value))
    : result;
}

/** Adapters call this before loading mutable state or waiting for stdin. */
export function validateProductReviewRequest(options: ProductReviewRequest): Result<void> {
  const submitting = options.assessments !== undefined;
  const sessionMode = validateSessionMode(options, submitting);
  if (!sessionMode.ok) return sessionMode;
  if (options.dispatch && (submitting || options.template || options.handoff))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "dispatch, template, handoff and assessment submission are mutually exclusive",
      ),
    );
  if (options.template && (submitting || options.handoff))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "template, handoff and assessment submission are mutually exclusive",
      ),
    );
  if (
    (options.handoff && submitting) ||
    (options.coverage !== undefined && !submitting) ||
    (options.reviewer !== undefined && !submitting) ||
    (options.feedback !== undefined && !submitting) ||
    (options.experimentResolutions !== undefined && !submitting)
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "handoff is read-only; coverage and reviewer context require an assessment submission",
      ),
    );
  return ok(undefined);
}

function validateSessionMode(options: ProductReviewRequest, submitting: boolean): Result<void> {
  const reading = [options.dispatch, options.template, options.handoff].some(Boolean);
  const identity = [options.subjectDigest, options.selection, options.captures].some(
    (value) => value !== undefined,
  );
  if (
    (options.prepare && (submitting || options.session || reading)) ||
    (options.session && (!submitting || reading || identity))
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "prepare requires a read selection; session submission requires judgments without authored identity",
        {
          recovery: options.session
            ? "Use the submission object in this session's packet.json; omit subjectDigest, selection and captures."
            : "Use visp review --prepare with feature/task selection only, then submit judgments with the returned --session.",
        },
      ),
    );
  return ok(undefined);
}
