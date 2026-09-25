import { z } from "zod";
import {
  CRITIC_MAX_CALLS,
  criticConfigSchema,
  criticHarnessSchema,
  criticModeSchema,
  reasoningEffortSchema,
} from "../../config/critic.js";
import { historicalCriticConfigSchema } from "../../config/critic-history.js";
import { qualityDimensionSchema } from "./feedback-model.js";
import { productReviewSubmissionSchema } from "./review-request.js";

export { type CriticConfig, criticConfigSchema } from "../../config/critic.js";

export const criticPhaseSchema = z.enum(["understanding", "product"]);
export type CriticPhase = z.infer<typeof criticPhaseSchema>;

export const nativeCapabilitySchema = z
  .object({
    harness: criticHarnessSchema,
    model: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.optional(),
    freshContext: z.boolean(),
    images: z.boolean(),
    readOnly: z.boolean(),
    delegationAllowed: z.boolean().optional(),
  })
  .strict();
export const nativeResultSchema = z
  .object({
    attempt: z.string().uuid(),
    model: z.string().min(1).max(200),
    reasoningEffort: reasoningEffortSchema.optional(),
    context: z.enum(["fresh", "current", "unavailable"]),
    outputTokens: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    response: z.unknown().optional(),
    failure: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const criticRequestSchema = z
  .object({
    feature: z.string().optional(),
    task: z.string().optional(),
    phase: criticPhaseSchema.optional(),
    question: z.string().trim().min(1).optional(),
    sourceOnly: z.boolean().optional(),
    operation: z
      .enum([
        "status",
        "configure",
        "review",
        "preflight",
        "prepare",
        "submit",
        "restore",
        "disable",
        "set-policy",
        "reconcile",
      ])
      .default("status"),
    config: criticConfigSchema.optional(),
    enabled: z.boolean().optional(),
    mode: criticModeSchema.optional(),
    harness: criticHarnessSchema.optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    capabilities: nativeCapabilitySchema.optional(),
    result: nativeResultSchema.optional(),
    attempt: z.string().uuid().optional(),
    response: z.unknown().optional(),
    failure: z.string().trim().min(1).max(2000).optional(),
    retryAfter: z.string().uuid().optional(),
    notInvoked: z.boolean().optional(),
    failureKind: z
      .enum([
        "host-unavailable",
        "permission-denied",
        "model-unavailable",
        "image-unavailable",
        "invocation-failed",
        "schema-rejected",
        "setup-unverified",
      ])
      .optional(),
    candidate: z
      .string()
      .regex(/^CAN-[a-f0-9]{32}$/)
      .optional(),
    expectedSubject: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type CriticRequest = z.infer<typeof criticRequestSchema>;
export function isEarlyCriticGap(
  request: CriticRequest,
): request is CriticRequest & { failure: string } {
  return (
    request.operation === "submit" &&
    request.phase === "understanding" &&
    !!request.failure &&
    request.attempt === undefined &&
    !request.result &&
    request.response === undefined
  );
}

export const criticResponseSchema = z
  .object({
    review: productReviewSubmissionSchema,
    comparison: z
      .array(
        z
          .object({
            dimension: qualityDimensionSchema,
            change: z.enum(["better", "same", "worse", "unknown"]),
            reason: z.string().trim().min(1),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    evidenceRequest: z.string().trim().min(1).optional(),
  })
  .strict();
export type CriticResponse = z.infer<typeof criticResponseSchema>;
const criticAdapterCallSchema = z
  .object({
    startedAt: z.number().optional(),
    finishedAt: z.number(),
    outcome: z.enum(["returned", "failed", "timed-out", "cancelled"]),
  })
  .strict();
export type CriticAdapterCall = z.infer<typeof criticAdapterCallSchema>;

const attemptSchema = z
  .object({
    id: z.string(),
    phase: criticPhaseSchema.optional(),
    candidate: z.string(),
    subject: z.string(),
    contract: z.string(),
    implementation: z.string(),
    intent: z.string().optional(),
    evidenceDigest: z.string(),
    selectionDigest: z.string(),
    selection: productReviewSubmissionSchema.shape.selection,
    comparisonCandidate: z.string().optional(),
    transport: z.enum(["sampling", "native"]).optional(),
    hostReport: nativeCapabilitySchema.optional(),
    requiresImages: z.boolean().optional(),
    sourceOnly: z.boolean().optional(),
    startedAt: z.number(),
    status: z.enum(["pending", "reviewed", "unavailable"]),
    gaps: z.array(z.string()).optional(),
    message: z.string().optional(),
    failureKind: criticRequestSchema.shape.failureKind,
    recovery: z
      .object({
        after: z.string(),
        reason: z.string(),
        provenance: z.literal("host-reported"),
      })
      .strict()
      .optional(),
    response: criticResponseSchema.optional(),
    advisoryResponse: criticResponseSchema.optional(),
    execution: z
      .object({
        provenance: z.enum(["adapter-observed", "host-reported"]),
        claimed: z.boolean().optional(),
        adapterCall: criticAdapterCallSchema.optional(),
        invoked: z.boolean().optional(),
        returned: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const criticStateSchema = z
  .object({
    version: z.literal(1),
    root: z.string(),
    feature: z.string(),
    task: z.string().optional(),
    contract: z.string(),
    intent: z.string(),
    config: historicalCriticConfigSchema,
    disabled: z.boolean().default(false),
    attempts: z.array(attemptSchema).max(CRITIC_MAX_CALLS),
    preferredCandidate: z.string().optional(),
    understandingGap: z
      .object({
        reason: z.string().min(1),
        intent: z.string(),
        provenance: z.literal("host-reported"),
        category: z.string().optional(),
      })
      .strict()
      .optional(),
    intentRevisions: z
      .array(
        z
          .object({
            before: z.string(),
            after: z.string(),
            briefDigest: z.string(),
            reason: z.string(),
            provenance: z.string(),
            createdAt: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type CriticState = z.infer<typeof criticStateSchema>;

export { CRITIC_INSTRUCTIONS, UNDERSTANDING_CRITIC_INSTRUCTIONS } from "./review-instructions.js";
