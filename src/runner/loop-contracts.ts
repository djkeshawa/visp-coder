import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const feedbackLoopSchema = z
  .object({
    maxRounds: z.number().int().min(1).max(10),
    actorMaxDurationMs: z.number().int().positive().max(86_400_000),
    reviewMaxDurationMs: z.number().int().positive().max(600_000),
    criteria: z
      .array(z.object({ id, expectation: z.string().trim().min(1).max(2400) }).strict())
      .min(1)
      .max(30),
    reviewerInstructions: z.string().max(12_000).optional(),
  })
  .strict()
  .superRefine((loop, context) => {
    if (new Set(loop.criteria.map((entry) => entry.id)).size !== loop.criteria.length)
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Review criteria IDs must be unique",
      });
  });

export const loopReviewSchema = z
  .object({
    subjectDigest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["pass", "repair", "evidence", "unavailable"]),
    checks: z
      .array(
        z
          .object({
            id,
            status: z.enum(["passed", "failed", "unverified"]),
            exercise: z.string().trim().min(1).max(2400),
            observed: z.string().trim().min(1).max(2400),
            evidence: z.array(z.string().trim().min(1).max(1200)).max(12),
          })
          .strict(),
      )
      .max(30),
    findings: z
      .array(
        z
          .object({
            criterion: id,
            problem: z.string().trim().min(1).max(2400),
            nextCheck: z.string().trim().min(1).max(2400),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();
export type LoopReview = z.infer<typeof loopReviewSchema>;
export interface FeedbackLoopSummary {
  readonly decision: LoopReview["decision"];
  readonly rounds: number;
  readonly repairAttempts: number;
  readonly evidenceRequests: number;
  readonly firstHandoffMs: number | null;
  readonly review?: LoopReview;
  readonly provenance: "host-reported-not-independent-acceptance";
}

export function parseLoopReview(
  text: string,
  subject: string,
  criteria: readonly { id: string }[],
  history: readonly LoopReview[] = [],
): LoopReview {
  const review = loopReviewSchema.parse(JSON.parse(text));
  const ids = new Set(review.checks.map((check) => check.id));
  if (review.subjectDigest !== subject)
    throw new Error("Reviewer judged a different candidate version");
  if (
    ids.size !== criteria.length ||
    ids.size !== review.checks.length ||
    criteria.some((criterion) => !ids.has(criterion.id))
  )
    throw new Error("Reviewer must assess every pinned criterion exactly once");
  if (review.findings.some((finding) => !ids.has(finding.criterion)))
    throw new Error("Finding refers to an unknown criterion");
  if (review.checks.some((check) => check.status !== "unverified" && !check.evidence.length))
    throw new Error("A claimed result requires evidence; unavailable evidence remains unverified");
  validateDecision(review);
  for (const failed of failedExercises(history)) {
    const rechecked = review.checks.find((check) => check.id === failed.id);
    if (rechecked?.status === "passed" && rechecked.exercise !== failed.exercise)
      throw new Error(
        "A repaired criterion must replay the same failing exercise; helper checks cannot replace it",
      );
  }
  return review;
}

function validateDecision(review: LoopReview): void {
  const failures = new Set(
    review.checks.filter((check) => check.status === "failed").map((check) => check.id),
  );
  if (
    review.decision === "pass" &&
    (review.findings.length || review.checks.some((check) => check.status !== "passed"))
  )
    throw new Error("Review cannot pass with findings or unverified/failed criteria");
  if (
    review.decision === "repair" &&
    !review.findings.some((finding) => failures.has(finding.criterion))
  )
    throw new Error("Repair requires a concrete failure and actionable finding");
  if (
    review.decision === "evidence" &&
    !review.checks.some((check) => check.status === "unverified")
  )
    throw new Error("Evidence requests must identify an unverified criterion");
}

export function failedExercises(history: readonly LoopReview[]) {
  const failed = new Map<string, { id: string; exercise: string }>();
  for (const review of history)
    for (const check of review.checks)
      if (check.status === "failed" && !failed.has(check.id))
        failed.set(check.id, { id: check.id, exercise: check.exercise });
  return [...failed.values()];
}
