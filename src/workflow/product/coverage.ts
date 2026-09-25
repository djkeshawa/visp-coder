import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import {
  evidenceApplies,
  evidenceSupportGaps,
  type ProductEvidenceCatalogue,
  resolveAssessmentEvidence,
} from "./evidence-references.js";
import {
  coverageAssessmentSchema,
  PRODUCT_REVIEW_POLICY,
  type ProductAssessment,
  type ProductCoverageAssessment,
  type ProductSlice,
} from "./model.js";
import type { ProductRecord } from "./store.js";

export interface ProductReviewChallenge {
  readonly id: string;
  readonly example: string;
  readonly title: string;
  readonly given: readonly string[];
  readonly when: string;
  readonly expected: string;
  readonly outcomes: readonly string[];
  readonly required: boolean;
}

/** Retained behavior examples supply questions, without another authored mapping document. */
export function productReviewChallenges(
  record: ProductRecord,
  slice?: ProductSlice,
): ProductReviewChallenge[] {
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  const challenges = new Map<string, ProductReviewChallenge>();
  for (const example of record.brief.examples) {
    const relevant = outcomes.filter((outcome) => example.outcomes.includes(outcome.id));
    if (!relevant.length) continue;
    for (const expected of example.expected) {
      const id = `EX-${example.id}-${hashValue({ given: example.given, when: example.when, expected }).slice(0, 12)}`;
      challenges.set(id, {
        id,
        example: example.id,
        title: example.title,
        given: example.given,
        when: example.when,
        expected,
        outcomes: relevant.map((outcome) => outcome.id),
        required: relevant.some((outcome) => outcome.priority === "must"),
      });
    }
  }
  return [...challenges.values()];
}

export function currentCoverage(
  record: ProductRecord,
  subject: string,
): ProductCoverageAssessment[] {
  const current = new Map<string, ProductCoverageAssessment>();
  for (const review of record.state.reviews) {
    if (review.policyVersion !== PRODUCT_REVIEW_POLICY || !evidenceApplies(record, subject, review))
      continue;
    for (const assessment of review.coverage ?? []) current.set(assessment.id, assessment);
  }
  return [...current.values()];
}

/** Keep the next review small; unassessed and failed examples cannot disappear through the cap. */
export function selectReviewChallenges(
  challenges: readonly ProductReviewChallenge[],
  coverage: readonly ProductCoverageAssessment[],
) {
  const statuses = new Map(coverage.map((entry) => [entry.id, entry.status]));
  const rank = (entry: ProductReviewChallenge) =>
    (entry.required ? 0 : 3) +
    (statuses.get(entry.id) === "failed" ? 0 : statuses.get(entry.id) === "satisfied" ? 2 : 1);
  const selected = [...challenges].sort((a, b) => rank(a) - rank(b)).slice(0, 12);
  return { selected, omitted: Math.max(0, challenges.length - selected.length) };
}

export function validateCoverage(
  input: unknown,
  challenges: readonly ProductReviewChallenge[],
  catalogue: ProductEvidenceCatalogue,
  functionalOutcomes: ReadonlySet<string> = new Set(),
): Result<ProductCoverageAssessment[]> {
  const parsed = z.array(coverageAssessmentSchema).safeParse(input ?? []);
  if (!parsed.success)
    return err(vispError("ARTIFACT_INVALID", `Invalid example coverage: ${parsed.error.message}`));
  const known = new Map(challenges.map((entry) => [entry.id, entry]));
  if (
    new Set(parsed.data.map((entry) => entry.id)).size !== parsed.data.length ||
    parsed.data.some((entry) => !known.has(entry.id))
  )
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Coverage must name distinct challenge IDs from the current review scope",
      ),
    );
  const result: ProductCoverageAssessment[] = [];
  const evidenceById = new Map(catalogue.entries.map((entry) => [entry.id, entry]));
  for (const entry of parsed.data) {
    const resolved = resolveAssessmentEvidence(
      {
        outcome: "coverage",
        status: entry.status,
        provenance: "agent-reported",
        expectations: [],
        summary: entry.reason,
        evidence: entry.evidence,
      },
      catalogue,
    );
    if (!resolved.ok) return resolved;
    const gaps =
      entry.status === "satisfied"
        ? [
            ...evidenceSupportGaps(
              resolved.value.evidence,
              catalogue,
              undefined,
              known.get(entry.id)?.outcomes.some((outcome) => functionalOutcomes.has(outcome)) ===
                true,
            ),
            ...coverageMappingGaps(
              resolved.value.evidence,
              evidenceById,
              known.get(entry.id)?.outcomes ?? [],
            ),
          ]
        : [];
    result.push({
      ...entry,
      evidence: resolved.value.evidence,
      ...(gaps.length
        ? { status: "unavailable" as const, reason: `${entry.reason}\n${gaps.join("\n")}` }
        : {}),
    });
  }
  return ok(result);
}

function coverageMappingGaps(
  references: readonly string[],
  known: ReadonlyMap<string, ProductEvidenceCatalogue["entries"][number]>,
  outcomes: readonly string[],
): string[] {
  return references.flatMap((id) => {
    const evidence = known.get(id);
    return evidence?.outcomes.length &&
      !evidence.outcomes.some((outcome) => outcomes.includes(outcome))
      ? [
          `${id}: declared evidence mapping does not include any challenge outcome (${outcomes.join(", ")})`,
        ]
      : [];
  });
}

/** A reported failure in an example cannot coexist with a passing parent outcome. */
export function applyCoverageFailures(
  assessments: readonly ProductAssessment[],
  challenges: readonly ProductReviewChallenge[],
  coverage: readonly ProductCoverageAssessment[],
): ProductAssessment[] {
  const failures = coverage.filter((entry) => entry.status === "failed");
  return assessments.map((assessment) => {
    const relevant = failures.filter((entry) =>
      challenges.some(
        (challenge) => challenge.id === entry.id && challenge.outcomes.includes(assessment.outcome),
      ),
    );
    return relevant.length && assessment.status !== "failed"
      ? {
          ...assessment,
          status: "failed" as const,
          summary: `${assessment.summary}\n${relevant.map((entry) => `${entry.id}: ${entry.reason}`).join("\n")}`,
        }
      : assessment;
  });
}
