import { z } from "zod";

/** The explanation is reviewer-reported; execution and capture identity remain runner-owned. */
export const experimentResolutionSchema = z
  .object({
    provenance: z.literal("agent-reported").default("agent-reported"),
    runId: z.string().min(1),
    replacementRunId: z.string().min(1),
    outcome: z.string().min(1),
    reason: z.string().trim().min(1).max(2400),
    evidence: z.array(z.string().min(1)).min(2).max(12),
  })
  .strict();
export const experimentResolutionsSchema = z.array(experimentResolutionSchema).max(3);
export type ExperimentResolution = z.infer<typeof experimentResolutionSchema>;
