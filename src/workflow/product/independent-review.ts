import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { feedbackResolutionSchema, type ProductFeedback } from "./feedback-model.js";
import type { ProductOutcome } from "./model.js";
import { normalizeIndependentEvidence } from "./review-citations.js";

const text = z.string().trim().min(1);
const evidence = z.array(
  text.describe("Exact supplied evidence ID; put explanations in the surrounding judgment text."),
);
const status = z.enum(["satisfied", "failed", "unclear", "unavailable"]);
/** Shared judgment contract; historical resolutions may omit their repair disposition. */
export const independentReviewSchema = z
  .object({
    summary: text,
    assessments: z.array(
      z
        .object({
          outcome: text.describe("Exact supplied outcome ID; put its description in summary."),
          status,
          summary: text,
          evidence,
          expectations: z.array(z.object({ id: text, status, reason: text, evidence }).strict()),
        })
        .strict(),
    ),
    findings: z
      .array(
        z
          .object({
            problem: text,
            consequence: text,
            nextCheck: text,
            evidence,
            outcomes: z.array(text.describe("Exact supplied outcome ID, without its description.")),
            required: z.boolean(),
          })
          .strict(),
      )
      .max(3),
    limitations: z.array(text),
    resolutions: z.array(feedbackResolutionSchema),
  })
  .strict();
export type IndependentReview = z.infer<typeof independentReviewSchema>;
/** Expand converter aliases: provider structured output rejects refs into nested properties. */
export function independentReviewJsonSchema(
  evidenceIds?: readonly string[],
  outcomeIds?: readonly string[],
) {
  const root = toJsonSchemaCompat(independentReviewSchema);
  function expand(value: unknown, ancestors = new Set<string>()): unknown {
    if (Array.isArray(value)) return value.map((entry) => expand(entry, ancestors));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (typeof object.$ref === "string") {
      const reference = object.$ref;
      if (!reference.startsWith("#/") || ancestors.has(reference))
        throw new Error("Unsupported recursive or external critic schema reference");
      const target = schemaReference(root, reference);
      return expand(target, new Set([...ancestors, reference]));
    }
    const expandedObject = Object.fromEntries(
      Object.entries(object).map(([key, entry]) => {
        const expanded = expand(entry, ancestors);
        return [key, referenceField(key, expanded, evidenceIds, outcomeIds)];
      }),
    );
    // Structured-output providers require all properties. New responses make the
    // disposition explicit; the validator still reads historical omitted values.
    if (expandedObject.type === "object" && expandedObject.properties)
      expandedObject.required = Object.keys(expandedObject.properties as object);
    return expandedObject;
  }
  return expand(root) as Record<string, unknown>;
}
function referenceField(
  key: string,
  field: unknown,
  evidenceIds?: readonly string[],
  outcomeIds?: readonly string[],
) {
  if (key === "evidence") return referenceArray(field, evidenceIds);
  if (key === "outcomes") return referenceArray(field, outcomeIds);
  if (!outcomeIds || !field || typeof field !== "object") return field;
  if (key === "outcome" && outcomeIds.length) return { ...field, enum: [...new Set(outcomeIds)] };
  if (key === "assessments" && !outcomeIds.length) return { ...field, maxItems: 0 };
  return field;
}
/** Constrain reference selection, not the reviewer's conclusions or length. */
function referenceArray(field: unknown, evidenceIds?: readonly string[]) {
  if (
    !evidenceIds ||
    !field ||
    typeof field !== "object" ||
    !("type" in field) ||
    field.type !== "array"
  )
    return field;
  return {
    ...field,
    ...(evidenceIds.length ? {} : { maxItems: 0 }),
    items: {
      type: "string",
      ...(evidenceIds.length ? { enum: [...new Set(evidenceIds)] } : {}),
    },
  };
}

function schemaReference(root: unknown, reference: string): unknown {
  let target = root;
  for (const part of reference.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    target =
      target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
  }
  if (!target) throw new Error("Unresolved critic schema reference");
  return target;
}

export function independentReviewTemplate() {
  return {
    summary:
      "Describe what you inspected and concluded; distinguish observations from inferred causes.",
    assessments: [],
    findings: [],
    limitations: [],
    resolutions: [],
  };
}

export function independentJudgments(
  review: IndependentReview,
  phase: ProductFeedback["phase"],
  outcomes: readonly ProductOutcome[] = [],
) {
  review = normalizeIndependentEvidence(review);
  return {
    assessments: review.assessments,
    feedback: {
      phase,
      dimensions: [],
      findings: review.findings.map((finding) => {
        const outcome = outcomes.find((entry) => finding.outcomes.includes(entry.id));
        const dimension =
          outcome?.kind === "experience"
            ? "experience"
            : outcome?.kind === "quality"
              ? "non-functional"
              : finding.outcomes.length
                ? "functional"
                : "fidelity";
        return {
          dimension,
          problem: `${finding.problem}\nConsequence: ${finding.consequence}`,
          nextCheck: finding.nextCheck,
          outcomes: finding.outcomes,
          required: finding.required,
          evidence: finding.evidence,
        };
      }),
      resolutions: review.resolutions,
      summary: review.summary,
      limitations: review.limitations,
    } satisfies ProductFeedback,
  };
}
