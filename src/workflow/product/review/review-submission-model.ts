import { z } from "zod";
import { experimentResolutionsSchema } from "../experiment-model.js";
import { productFeedbackSchema } from "../feedback-model.js";
import { assessmentSchema, coverageAssessmentSchema, reviewerContextSchema } from "../model.js";
import { reviewSelectionSchema } from "./review-selection.js";

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
