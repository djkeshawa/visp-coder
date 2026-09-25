/// <reference lib="dom" />
import { z } from "zod";
import { BrowserBehaviorFailure } from "./browser-observations.js";
import type { BrowserSession } from "./browser-session.js";

const target = z
  .object({
    selector: z.string().min(1).max(2048),
    attribute: z
      .string()
      .min(1)
      .max(256)
      .describe("HTML attribute read with getAttribute, not a DOM property.")
      .optional(),
  })
  .strict();
export const browserComparisonSchema = z
  .object({
    kind: z.literal("compare"),
    left: target,
    right: z.union([target, z.object({ value: z.string().max(2048) }).strict()]),
    relation: z.enum(["equal", "not-equal", "less-than", "greater-than"]),
    mode: z.enum(["text", "number"]).default("text"),
    capture: z.boolean().default(false),
  })
  .strict();
export type BrowserComparison = z.infer<typeof browserComparisonSchema>;

/** Read both values in one browser task, without mutating product state. */
export function readComparison(action: BrowserComparison) {
  const read = (target: BrowserComparison["right"]) => {
    if ("value" in target) return { count: 1, value: target.value, truncated: false };
    const elements = document.querySelectorAll(target.selector);
    const element = elements.length === 1 ? elements[0] : undefined;
    const value = target.attribute ? element?.getAttribute(target.attribute) : element?.textContent;
    return {
      count: elements.length,
      value: value?.slice(0, 2048) ?? null,
      truncated: (value?.length ?? 0) > 2048,
    };
  };
  return { left: read(action.left), right: read(action.right) };
}

export function comparisonMatches(
  action: BrowserComparison,
  actual: ReturnType<typeof readComparison>,
) {
  if (
    [actual.left, actual.right].some(
      (entry) => entry.count !== 1 || entry.value === null || entry.truncated,
    )
  )
    return false;
  if (action.mode === "text" && ["less-than", "greater-than"].includes(action.relation))
    return false;
  const leftText = actual.left.value?.trim() ?? "";
  const rightText = actual.right.value?.trim() ?? "";
  // Empty UI labels cannot jointly establish a successful product invariant.
  if (!leftText || !rightText) return false;
  const left = action.mode === "number" ? Number(leftText) : leftText;
  const right = action.mode === "number" ? Number(rightText) : rightText;
  if (action.mode === "number" && (!Number.isFinite(left) || !Number.isFinite(right))) return false;
  switch (action.relation) {
    case "equal":
      return left === right;
    case "not-equal":
      return left !== right;
    case "less-than":
      return left < right;
    case "greater-than":
      return left > right;
  }
}

export async function compareBrowserValues(session: BrowserSession, action: BrowserComparison) {
  const actual = await session.sample(readComparison, action);
  const matched = comparisonMatches(action, actual);
  const id = session.record(
    "observe",
    `Compare ${action.left.selector} ${action.relation} ${"selector" in action.right ? action.right.selector : "retained value"}`,
    { expected: action, actual, matched },
  );
  if (!matched)
    throw new BrowserBehaviorFailure(
      `Browser comparison failed: ${action.left.selector} ${action.relation}; left=${comparisonPreview(actual.left)}; right=${comparisonPreview(actual.right)}.${action.left.attribute || ("selector" in action.right && action.right.attribute) ? " Attributes use getAttribute(), not DOM properties; a missing value cannot satisfy any relation." : ""}`,
      "failed",
      id,
    );
}

function comparisonPreview(entry: ReturnType<typeof readComparison>["left"]): string {
  return JSON.stringify({
    value: entry.value?.slice(0, 120) ?? null,
    matches: entry.count,
    truncated: entry.truncated || (entry.value?.length ?? 0) > 120,
  });
}
