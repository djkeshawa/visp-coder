import { z } from "zod";
import { browserInputIdentitySchema } from "../../testing/browser-input-identity.js";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import { captureSchema } from "./images.js";
import { journeyExpectationSchema } from "./journey-ownership.js";

export const captureOperationSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "navigate",
    "measure",
    "pointer",
    "touch",
    "keyboard",
    "capture",
    "observe",
    "scroll",
  ]),
  description: z.string().optional(),
  measurement: z.object({ json: z.string(), truncated: z.boolean() }).optional(),
});
export const productCaptureRunSchema = z.object({
  id: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  provenance: z.literal("runner-executed"),
  subjectDigest: z.string(),
  outcomeDigest: z.string().optional(),
  contractDigest: z.string().optional(),
  task: z.string().optional(),
  journeyDigest: z.string().optional(),
  comparisonEnvironment: z.string().optional(),
  journey: browserJourneySchema.optional(),
  journeyKey: z.string().optional(),
  expectation: journeyExpectationSchema.optional(),
  status: z.enum(["completed", "failed", "timed-out", "cancelled"]).optional(),
  completedInputs: z.array(browserInputIdentitySchema).optional(),
  failure: z
    .object({
      kind: z.string(),
      message: z.string(),
      operationId: z.string().optional(),
      input: browserInputIdentitySchema.optional(),
    })
    .optional(),
  captures: z.array(captureSchema),
  operations: z.array(captureOperationSchema),
});
