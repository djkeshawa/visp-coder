import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { DeliveredProductImageGroup } from "./images.js";

/** Bound presentation only; full groups and capture integrity remain available to the engine. */
export function boundedImageGroupMetadata(
  groups: readonly DeliveredProductImageGroup[],
  references: readonly string[],
  captures: ReadonlyMap<string, ProductReviewCapture>,
) {
  const requested = new Set(references);
  const rank = (group: DeliveredProductImageGroup) => {
    if (group.status === "delivered") return 0;
    const explicit =
      requested.has(group.id) ||
      group.captureIds.some(
        (id) => requested.has(id) || requested.has(captures.get(id)?.path ?? ""),
      );
    return explicit ? 1 : 2;
  };
  const selected = groups
    .map((group, index) => ({ group, rank: rank(group), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, 12)
    .map(({ group }) => ({
      ...group,
      captureIds: [...new Set([...group.deliveredCaptureIds, ...group.captureIds])].slice(0, 6),
      omittedCaptureIds: group.omittedCaptureIds.slice(0, 6),
    }));
  return { groups: selected, groupsOmitted: Math.max(0, groups.length - selected.length) };
}
