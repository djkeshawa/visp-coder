import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { err, type Result } from "../../core/result.js";
import {
  briefIssueLines,
  type ProductBrief,
  parseProductBrief,
  productBriefInputSchema,
} from "./model.js";

const fields = productBriefInputSchema.shape;

/** Arrays update entries by ID; omitted IDs append entries for the normal allocator. */
export const productBriefPatchSchema = productBriefInputSchema
  .omit({ version: true, feature: true, originalRequest: true, acceptanceBaseline: true })
  .partial()
  .extend({
    outcomes: z.array(fields.outcomes.removeDefault().element.partial()).optional(),
    examples: z.array(fields.examples.removeDefault().element.partial()).optional(),
    decisions: z.array(fields.decisions.removeDefault().element.partial()).optional(),
    checks: z.array(fields.checks.removeDefault().element.partial()).optional(),
    slices: z
      .array(
        fields.slices.removeDefault().element.partial().extend({
          scope: fields.slices.removeDefault().element.shape.scope.partial().optional(),
        }),
      )
      .optional(),
    design: fields.design.unwrap().partial().optional(),
  });

export function patchProductBrief(brief: ProductBrief, input: unknown): Result<ProductBrief> {
  const parsed = productBriefPatchSchema.safeParse(input);
  if (!parsed.success)
    return err(
      vispError("ARTIFACT_INVALID", `Invalid brief patch:\n${briefIssueLines(parsed.error)}`, {
        recovery:
          "Submit only changed fields. Arrays update entries by id; omit id only for a new entry. Leave version, feature, originalRequest and acceptanceBaseline to VISP.",
      }),
    );
  const patch = parsed.data;
  const merged: Record<string, unknown> = { ...brief, ...patch };
  for (const key of ["outcomes", "examples", "decisions", "checks", "slices"] as const) {
    const changes = patch[key];
    if (!changes) continue;
    const ids = changes.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]));
    if (new Set(ids).size !== ids.length)
      return err(vispError("ARTIFACT_INVALID", `Duplicate ${key} id in brief patch`));
    merged[key] = mergeEntries(brief[key], changes);
  }
  if (patch.design) merged.design = { ...brief.design, ...patch.design };
  return parseProductBrief(merged);
}

function mergeEntries(
  current: readonly { id: string }[],
  changes: readonly { id?: string }[],
): Record<string, unknown>[] {
  const positions = new Map(current.map((entry, index) => [entry.id, index]));
  const entries: Record<string, unknown>[] = current.map((entry) => ({ ...entry }));
  for (const change of changes) {
    const index = change.id === undefined ? undefined : positions.get(change.id);
    if (index === undefined) entries.push({ ...change });
    else {
      const previous = entries[index];
      entries[index] = { ...previous, ...change };
      if ("scope" in change && change.scope && typeof change.scope === "object")
        entries[index].scope = { ...(previous?.scope as object), ...change.scope };
    }
  }
  return entries;
}
