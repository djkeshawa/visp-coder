import { z } from "zod";
import { criterionIdSchema } from "./common.js";

export const evidenceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const outputSurfaceSchema = z.enum([
  "dom",
  "canvas",
  "webgl",
  "artifact",
  "data",
  "service",
]);
const expectation = z.string().trim().min(1).max(500);
const checkpointSchema = z
  .object({
    id: evidenceIdSchema,
    phase: z.enum(["before", "during", "after", "recovery"]),
    expectation,
  })
  .strict();
const negativeControlSchema = z.object({ id: evidenceIdSchema, expectation }).strict();

/** Optional on legacy criteria. Explicit expectations, not inferred from test names. */
export const evidenceContractSchema = z
  .object({
    surface: outputSurfaceSchema,
    checkpoints: z.array(checkpointSchema).min(1).max(16),
    negativeControls: z.array(negativeControlSchema).max(16).default([]),
    /** Requires fresh image-backed observations; remains a recorded judgment, not machine truth. */
    reviewRequired: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["checkpoints", "negativeControls"] as const) {
      const ids = value[key].map((entry) => entry.id);
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Evidence ids must be unique",
        });
    }
  });

export type EvidenceContract = z.infer<typeof evidenceContractSchema>;
export type OutputSurface = z.infer<typeof outputSurfaceSchema>;
const receipt = {
  criterion: criterionIdSchema,
  id: evidenceIdSchema,
  surface: outputSurfaceSchema,
  outcome: z.enum(["passed", "failed"]),
};
export const evidenceReceiptSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...receipt,
      kind: z.literal("checkpoint"),
      samples: z.number().int().min(0).max(1_000),
    })
    .strict(),
  z
    .object({
      ...receipt,
      kind: z.literal("negative-control"),
      baselinePassed: z.literal(true),
      changedPassed: z.literal(false),
    })
    .strict(),
]);
export type EvidenceReceipt = z.infer<typeof evidenceReceiptSchema>;
