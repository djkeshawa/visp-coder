import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { ImageDeliveryCandidate } from "./image-groups.js";
import type { ProductImageAvailability } from "./images.js";

type Availability = ReadonlyMap<string, ProductImageAvailability>;
type Captures = ReadonlyMap<string, ProductReviewCapture>;

function viewport(id: string, captures: Captures) {
  const size = captures.get(id)?.viewport;
  return size ? `${size.width}x${size.height}` : undefined;
}
function availableIds(candidate: ImageDeliveryCandidate, availability: Availability) {
  return (candidate.group?.captureIds ?? candidate.captureIds).filter((id) =>
    ["delivered", "not-delivered"].includes(availability.get(id)?.status ?? ""),
  );
}
function pendingViewports(
  candidates: readonly ImageDeliveryCandidate[],
  availability: Availability,
  captures: Captures,
) {
  const delivered = new Set(
    [...availability.values()]
      .filter((entry) => entry.status === "delivered")
      .map((entry) => viewport(entry.id, captures)),
  );
  const sizes = new Map<string, number>();
  for (const entry of candidates)
    for (const id of availableIds(entry, availability)) {
      const key = viewport(id, captures);
      const size = availability.get(id)?.byteLength;
      if (key && size !== undefined && !delivered.has(key))
        sizes.set(key, Math.min(sizes.get(key) ?? Infinity, size));
    }
  return sizes;
}

/** Reserve one intact representative of each viewport before spending spare slots on journeys. */
export function reserveViewportSample(
  candidate: ImageDeliveryCandidate,
  candidates: readonly ImageDeliveryCandidate[],
  availability: Availability,
  captures: Captures,
  slots: number,
  bytes: number,
): ImageDeliveryCandidate {
  const available = availableIds(candidate, availability);
  if (!available.length) return candidate;
  const intact = candidate.captureIds.filter((id) => available.includes(id));
  const sample = intact.length ? intact : available.slice(-1);
  candidate = {
    ...candidate,
    captureIds: sample,
    omittedCaptureIds: [
      ...new Set([
        ...candidate.omittedCaptureIds,
        ...candidate.captureIds.filter((id) => !sample.includes(id)),
      ]),
    ],
  };
  const sizes = pendingViewports(candidates, availability, captures);
  const current = viewport(candidate.captureIds[0] ?? "", captures);
  const unseen = sizes.has(current ?? "");
  sizes.delete(current ?? "");
  // With more viewports than slots, prioritize candidates in their existing relevance order.
  const pending = candidate.captureIds.filter((id) => availability.get(id)?.status !== "delivered");
  const pool = available.filter((id) => availability.get(id)?.status !== "delivered");
  const minimum = pool.length
    ? Math.min(...pool.map((id) => availability.get(id)?.byteLength ?? 0))
    : 0;
  const reserved = affordableReservations(
    [...sizes.values()],
    Math.max(0, slots - Number(unseen)),
    bytes - minimum,
  );
  const room = slots - reserved.length;
  const byteRoom = bytes - reserved.reduce((sum, size) => sum + size, 0);
  const cost = pending.reduce((sum, id) => sum + (availability.get(id)?.byteLength ?? 0), 0);
  if (pending.length <= room && cost <= byteRoom) return candidate;
  const selected = selectRepresentatives(
    [...new Set([...pending, ...pool])],
    availability,
    room,
    byteRoom,
  );
  const ids = available.filter(
    (id) => selected.has(id) || availability.get(id)?.status === "delivered",
  );
  return {
    ...candidate,
    captureIds: ids,
    omittedCaptureIds: [
      ...new Set([
        ...candidate.omittedCaptureIds.filter((id) => !ids.includes(id)),
        ...available.filter((id) => !ids.includes(id)),
      ]),
    ],
  };
}

function selectRepresentatives(
  pending: string[],
  availability: Availability,
  room: number,
  byteRoom: number,
) {
  const selected = new Set<string>();
  // Endpoints retain journey context; a single image is explicitly only a representative.
  const ranked = [...new Set([pending.at(-1), pending[0], ...pending])].filter(
    (id): id is string => id !== undefined,
  );
  for (const id of ranked) {
    if (selected.size >= room) break;
    const size = availability.get(id)?.byteLength ?? 0;
    if (size > byteRoom) continue;
    selected.add(id);
    byteRoom -= size;
  }
  return selected;
}

function affordableReservations(sizes: number[], slots: number, bytes: number) {
  const reserved: number[] = [];
  for (const size of sizes.sort((a, b) => a - b)) {
    if (reserved.length >= slots) break;
    if (size > bytes) continue;
    reserved.push(size);
    bytes -= size;
  }
  return reserved;
}
