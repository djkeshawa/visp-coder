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

export type ProductCaptureRun = z.infer<typeof productCaptureRunSchema>;

/**
 * The runner-executed capture runs of a record that parse. The state stores them as unchecked
 * JSON, so a run damaged on disk is skipped here and never counts as evidence.
 */
export function validCaptureRuns(source: CaptureRunSource): ProductCaptureRun[] {
  return captureRunEntries(source).map((entry) => entry.run);
}

/** Each valid run beside the stored value it came from, for callers that hand the stored value on. */
export function captureRunEntries(
  source: CaptureRunSource,
): { readonly stored: unknown; readonly run: ProductCaptureRun }[] {
  const candidates = "state" in source ? source.state.captureRuns : source;
  return candidates.flatMap((stored) => {
    const parsed = productCaptureRunSchema.safeParse(stored);
    return parsed.success ? [{ stored, run: parsed.data }] : [];
  });
}

type CaptureRunSource =
  | { readonly state: { readonly captureRuns: readonly unknown[] } }
  | readonly unknown[];
