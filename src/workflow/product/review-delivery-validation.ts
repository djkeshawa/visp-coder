import { z } from "zod";
import type { ProductSource } from "./sources.js";

/** Internal delivery metadata; reviewer-authored submissions cannot supply this authority. */
export interface DeliveredReviewEvidence {
  readonly ids: readonly string[];
  readonly generatedReferences: readonly z.infer<typeof generatedSourceReferencesSchema>[number][];
}

export const generatedSourceReferencesSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(200),
        kind: z.literal("source"),
        outcomes: z.array(z.string()),
        status: z.enum(["available", "unavailable"]),
        summary: z.string(),
      })
      .strict(),
  )
  .max(1000)
  .refine(
    (references) => JSON.stringify(references).length <= 32000,
    "Generated source references exceed the metadata budget",
  );

/** Preserve references created by final fitting, without storing all candidate source text. */
export function generatedSourceReferences(
  sources: readonly ProductSource[],
  candidates: readonly { id: string }[],
) {
  const known = new Set(candidates.map((entry) => entry.id));
  return sources
    .filter((source) => !known.has(source.id))
    .map((source) => ({
      id: source.id,
      kind: "source" as const,
      outcomes: [],
      status: source.available ? ("available" as const) : ("unavailable" as const),
      summary: source.excerpt,
    }));
}

/** Complete delivered identities, bounded independently of the number of candidates. */
export const deliveredEvidenceIdsSchema = z
  .array(z.string().min(1).max(200))
  .max(1000)
  .refine(
    (ids) => JSON.stringify(ids).length <= 32000,
    "Delivered evidence IDs exceed the metadata budget",
  );

export function reviewCitationGap(
  judgments: unknown,
  ids: readonly string[] | undefined,
  legacySources?: readonly { id: string; delivered: boolean }[],
) {
  if (ids === undefined && legacySources === undefined) return undefined;
  const delivered = new Set(
    ids ?? legacySources?.filter((source) => source.delivered).map((source) => source.id),
  );
  const missing = new Set<string>();
  JSON.stringify(judgments, (key, value) => {
    if (key === "evidence" && Array.isArray(value))
      for (const id of value)
        if ((ids !== undefined || String(id).startsWith("CODE-")) && !delivered.has(id))
          missing.add(String(id));
    return value;
  });
  return missing.size ? `Unknown evidence reference: ${[...missing].join(", ")}` : undefined;
}
