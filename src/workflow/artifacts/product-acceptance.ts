import { z } from "zod";
import { artifactEnvelope, featureIdSchema, sha256Schema } from "./common.js";
import { commandResultSchema, criterionCheckSchema, findingSchema } from "./evidence.js";

export const productAcceptanceSchema = z
  .object({
    ...artifactEnvelope("product-acceptance"),
    feature: featureIdSchema,
    subject: sha256Schema,
    passed: z.boolean(),
    criteria: z.array(criterionCheckSchema),
    commands: z.array(commandResultSchema),
    findings: z.array(findingSchema),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.passed &&
      (record.criteria.length + record.commands.length === 0 ||
        record.criteria.some((check) => check.outcome !== "passed") ||
        record.commands.some(
          (command) => !command.passed || (command.testSummary?.skipped ?? 0) > 0,
        ) ||
        record.findings.some((finding) => finding.severity === "error"))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passed"],
        message:
          "Passing acceptance requires executed checks with no failed or unchecked expectations",
      });
  });

export type ProductAcceptance = z.infer<typeof productAcceptanceSchema>;

export interface ProductAcceptanceView {
  readonly status: "pending" | "passed" | "failed" | "stale";
  readonly findings: readonly z.infer<typeof findingSchema>[];
}
