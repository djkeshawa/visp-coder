import { z } from "zod";

export const QUALITY_DIMENSIONS = [
  "fidelity",
  "functional",
  "non-functional",
  "experience",
  "code",
] as const;
export const qualityDimensionSchema = z.enum(QUALITY_DIMENSIONS);
const text = z.string().trim().min(1);
export const feedbackResolutionSchema = z
  .object({
    id: text,
    disposition: z
      .enum(["repaired", "disproved"])
      .optional()
      .describe(
        "Omitted means repaired. Use disproved only when new executed counterevidence refutes the finding; explain why the claim or expectation was wrong, rather than claiming a repair.",
      ),
    environmentChange: z
      .object({
        from: text,
        to: text,
        explanation: text.describe(
          "Explain why the observed environment change repairs the defect without changing the verifier or intended behavior.",
        ),
      })
      .strict()
      .optional()
      .describe(
        "Only for an explicitly assessed functional repair across two known different comparisonEnvironment identities. Never a disproof or permission to change assertions.",
      ),
    explanation: text,
    evidence: z.array(text.describe("Exact supplied evidence ID.")).min(1),
    regression: z
      .union([
        z
          .object({ kind: z.literal("checked"), explanation: text, evidence: z.array(text).min(1) })
          .strict(),
        z.object({ kind: z.literal("not-applicable"), explanation: text }).strict(),
      ])
      .nullable()
      .optional()
      .describe(
        "For a functional repair, cite a distinct nearby behavior check and explain its relevance, or explain why no adjacent regression applies. Null is only for resolutions that do not need a repair regression.",
      ),
  })
  .strict();
export const productFeedbackSchema = z
  .object({
    phase: z.enum(["understanding", "product"]),
    summary: text.optional(),
    limitations: z.array(text).optional(),
    probes: z
      .array(
        z
          .object({
            kind: z.enum(["independent-result", "repeat-and-recover", "rendered-usability"]),
            expected: text.max(1200),
            basis: text.describe(
              "Where the expectation comes from; distinguish retained expectations from agent-proposed conventions. A preview is not an independent oracle.",
            ),
            exercise: text.max(1200),
            observed: text.max(1600),
            status: z.enum(["satisfied", "failed", "unclear", "unavailable", "not-applicable"]),
            evidence: z.array(z.string().min(1)).max(12).default([]),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    dimensions: z
      .array(
        z
          .object({
            dimension: qualityDimensionSchema,
            status: z.enum(["satisfied", "failed", "unclear", "unavailable", "not-applicable"]),
            reason: text,
            evidence: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .max(5),
    findings: z
      .array(
        z
          .object({
            dimension: qualityDimensionSchema,
            problem: text,
            nextCheck: text,
            outcomes: z.array(z.string().min(1)).default([]),
            required: z.boolean(),
            evidence: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .max(3)
      .default([]),
    resolutions: z.array(feedbackResolutionSchema).default([]),
  })
  .strict();
export type ProductFeedback = z.infer<typeof productFeedbackSchema>;
