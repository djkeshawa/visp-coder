import { z } from "zod";

/** The caller claims relevance; VISP binds the claim to an unchanged execution receipt. */
export const reproductionSchema = z
  .object({
    version: z.literal(1),
    finding: z.string().min(1),
    findingSubject: z.string().min(1),
    execution: z.string().min(1),
    executionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    explanation: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    provenance: z.literal("caller-reported"),
  })
  .strict();
