import { z } from "zod";
import { artifactEnvelope, isoTimestampSchema } from "../workflow/artifacts/common.js";

/**
 * Local-only record of what was attempted and what it cost. Never leaves the
 * machine; exists so claims about the workflow can be checked against data
 * rather than asserted.
 */

/**
 * Cost is the one thing here visp does not measure: earlier releases took these
 * from agent-supplied flags and nothing checks them.
 * Absent means unknown, which is not the same as zero.
 *
 * `null` is read as absent rather than rejected. Earlier builds let an
 * unparseable flag through as NaN, which `JSON.stringify` writes as `null`; a
 * strict read would then fail the whole file forever. A count nobody can read
 * is exactly a count we do not have.
 */
const selfReportedCount = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((count) => count ?? undefined);

export const attemptSchema = z
  .object({
    feature: z.string(),
    task: z.string().optional(),
    /** Whether verification and review passed on this attempt. */
    verified: z.boolean(),
    reviewed: z.boolean(),
    inputTokens: selfReportedCount,
    outputTokens: selfReportedCount,
    model: z.string().optional(),
    at: isoTimestampSchema,
  })
  .strict();

export type Attempt = z.infer<typeof attemptSchema>;

export const checkEventSchema = z
  .object({
    feature: z.string(),
    task: z.string().optional(),
    stage: z.enum(["verify", "review"]),
    outcome: z.enum(["passed", "refused", "error"]),
    attempt: z.number().int().positive(),
    source: z.enum(["direct", "done"]),
    errorCode: z.string().optional(),
    buildId: z.string().optional(),
    at: isoTimestampSchema,
  })
  .strict();

export type CheckEvent = z.infer<typeof checkEventSchema>;
export type CheckStage = CheckEvent["stage"];
export type CheckSource = CheckEvent["source"];

export const usageSegmentSchema = z
  .object({
    at: isoTimestampSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    inputTokens: z.number().int().safe().nonnegative(),
    cachedInputTokens: z.number().int().safe().nonnegative(),
    outputTokens: z.number().int().safe().nonnegative(),
    reasoningTokens: z.number().int().safe().nonnegative(),
  })
  .strict()
  .refine(
    (value) =>
      value.cachedInputTokens <= value.inputTokens && value.reasoningTokens <= value.outputTokens,
    "Usage segment subtotals exceed totals",
  );
export type UsageSegment = z.infer<typeof usageSegmentSchema>;

export const usageReceiptSchema = z
  .object({
    source: z.literal("codex"),
    runId: z.string().min(1),
    sourceFile: z.string().min(1),
    sourceFileHash: z.string().regex(/^[a-f0-9]{64}$/),
    projectRoot: z.string().min(1),
    startedAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
    importedAt: isoTimestampSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    inputTokens: z.number().int().safe().nonnegative(),
    cachedInputTokens: z.number().int().safe().nonnegative(),
    outputTokens: z.number().int().safe().nonnegative(),
    reasoningTokens: z.number().int().safe().nonnegative(),
    segments: z.array(usageSegmentSchema).optional(),
    attribution: z.literal("turn-context").optional(),
  })
  .strict()
  .refine(
    (value) => Date.parse(value.endedAt) >= Date.parse(value.startedAt),
    "Usage ends before it starts",
  )
  .refine(
    (value) =>
      value.cachedInputTokens <= value.inputTokens && value.reasoningTokens <= value.outputTokens,
    "Usage subtotals exceed totals",
  )
  .refine(
    (value) =>
      !value.segments ||
      ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"].every((field) => {
        const key = field as
          | "inputTokens"
          | "cachedInputTokens"
          | "outputTokens"
          | "reasoningTokens";
        return value.segments?.reduce((sum, segment) => sum + segment[key], 0) === value[key];
      }),
    "Usage segments do not reconcile with cumulative totals",
  )
  .refine((value) => {
    let previous = Date.parse(value.startedAt);
    for (const segment of value.segments ?? []) {
      const at = Date.parse(segment.at);
      if (at < previous || at > Date.parse(value.endedAt)) return false;
      previous = at;
    }
    return true;
  }, "Usage segments must be chronological and within the run interval");

export type UsageReceipt = z.infer<typeof usageReceiptSchema>;

export const telemetrySchema = z
  .object({
    ...artifactEnvelope("telemetry"),
    attempts: z.array(attemptSchema).default([]),
    checks: z.array(checkEventSchema).default([]),
    usageReceipts: z.array(usageReceiptSchema).default([]),
  })
  .strict();

export type Telemetry = z.infer<typeof telemetrySchema>;
