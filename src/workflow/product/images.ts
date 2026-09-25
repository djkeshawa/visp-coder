import { z } from "zod";
import { hashValue } from "../../core/hash.js";
import { inspectReviewImages, type ProductReviewCapture } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { boundedImageGroupMetadata } from "./image-group-metadata.js";
import {
  type ImageDeliveryCandidate,
  imageDeliveryCandidates,
  type ProductReviewImageGroup,
} from "./image-groups.js";

export const captureSchema = z.object({
  id: z.string(),
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  subjectDigest: z.string(),
  route: z.string(),
  steps: z.array(z.string()),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
  createdAt: z.string(),
  provenance: z.enum(["runner-captured", "agent-supplied"]),
});

export interface ProductImageAvailability {
  readonly id: string;
  readonly status: "delivered" | "not-delivered" | "unavailable" | "stale";
  readonly reason?: string;
  readonly byteLength?: number;
}

export interface DeliveredProductImageGroup extends ProductReviewImageGroup {
  /** Full counts remain explicit when the metadata ID lists are bounded. */
  readonly captureCount: number;
  readonly omittedCaptureCount: number;
  readonly deliveredCaptureIds: readonly string[];
  readonly omittedCaptureIds: readonly string[];
  readonly status: "delivered" | "not-delivered" | "unavailable";
  readonly reason?: string;
}

export async function inspectProductImages(
  workspace: WorkspaceState,
  subjectDigest: string,
  captures: readonly unknown[],
  preferredReferences: readonly string[] = [],
  groups: readonly ProductReviewImageGroup[] = [],
  selectedCaptureIds?: readonly string[],
) {
  const { valid, conflicts } = orderedCaptures(captures, subjectDigest, preferredReferences);
  const availability = new Map<string, ProductImageAvailability>();
  for (const id of conflicts)
    availability.set(id, { id, status: "unavailable", reason: "conflicting capture identity" });
  for (const capture of valid)
    availability.set(
      capture.id,
      await inspectCaptureAvailability(workspace, subjectDigest, capture),
    );
  const delivery: ImageDelivery = {
    images: [],
    availability,
    captures: new Map(valid.map((capture) => [capture.id, capture])),
    remaining: 8 * 1024 * 1024,
  };
  const deliveredGroups: DeliveredProductImageGroup[] = [];
  const selection = selectedCaptureIds === undefined ? undefined : new Set(selectedCaptureIds);
  // Apply an existing selection before sampling. Sampling first and intersecting
  // afterward silently loses requested intermediate states even with spare capacity.
  const selectedGroups = selection
    ? groups.map((group) => ({
        ...group,
        captureIds: group.captureIds.filter((id) => selection.has(id)),
      }))
    : groups;
  const originals = new Map(groups.map((group) => [group.id, group]));
  const candidates = imageDeliveryCandidates(
    selection ? valid.filter((capture) => selection.has(capture.id)) : valid,
    selectedGroups,
    selectedCaptureIds ?? preferredReferences,
  );
  for (const selected of candidates) {
    const original = selected.group && originals.get(selected.group.id);
    const candidate = original
      ? {
          ...selected,
          group: original,
          omittedCaptureIds: original.captureIds.filter((id) => !selected.captureIds.includes(id)),
        }
      : selected;
    const reason = await deliverCandidate(workspace, subjectDigest, candidate, delivery);
    const group = describeGroupDelivery(candidate, delivery, reason);
    if (group) deliveredGroups.push(group);
  }
  const gaps = [...availability.values()].flatMap((entry) =>
    entry.status === "unavailable" || entry.status === "stale"
      ? [`${entry.id}: ${entry.reason}`]
      : [],
  );
  if (!delivery.images.length)
    gaps.push("No intact image of the current product was delivered for review");
  return {
    images: delivery.images,
    gaps,
    availability: [...availability.values()],
    ...boundedImageGroupMetadata(deliveredGroups, preferredReferences, delivery.captures),
  };
}

interface ImageDelivery {
  readonly images: Awaited<ReturnType<typeof inspectReviewImages>>["images"];
  readonly availability: Map<string, ProductImageAvailability>;
  readonly captures: ReadonlyMap<string, ProductReviewCapture>;
  remaining: number;
}

function groupUnavailable(ids: readonly string[], delivery: ImageDelivery) {
  return ids.some(
    (id) => !["delivered", "not-delivered"].includes(delivery.availability.get(id)?.status ?? ""),
  );
}

async function deliverCandidate(
  workspace: WorkspaceState,
  subjectDigest: string,
  candidate: ImageDeliveryCandidate,
  delivery: ImageDelivery,
): Promise<string | undefined> {
  const ids = candidate.captureIds;
  if (!ids.length) return "Outside the preserved review selection";
  if (groupUnavailable(ids, delivery))
    return "A selected journey image is missing, stale or invalid; the group was not delivered";
  const pending = ids.filter((id) => delivery.availability.get(id)?.status !== "delivered");
  const size = pending.reduce(
    (sum, id) => sum + (delivery.availability.get(id)?.byteLength ?? 0),
    0,
  );
  if (delivery.images.length + pending.length > 6 || size > delivery.remaining)
    return "Image group delivery limit reached";
  const selected = pending.flatMap((id) => delivery.captures.get(id) ?? []);
  const inspected = await inspectReviewImages({
    subjectDigest,
    captures: selected,
    readBytes: (path) => readImageBytes(workspace, path),
  });
  if (inspected.images.length !== selected.length) {
    const reason =
      "Image changed or became inaccessible during delivery; the group was not delivered";
    const intact = new Set(inspected.images.map((image) => image.id));
    for (const id of pending)
      if (!intact.has(id)) delivery.availability.set(id, { id, status: "unavailable", reason });
    return reason;
  }
  delivery.images.push(...inspected.images);
  delivery.remaining -= size;
  for (const id of ids)
    delivery.availability.set(id, {
      id,
      status: "delivered",
      byteLength: delivery.availability.get(id)?.byteLength,
    });
  return undefined;
}

function describeGroupDelivery(
  candidate: ImageDeliveryCandidate,
  delivery: ImageDelivery,
  reason?: string,
): DeliveredProductImageGroup | undefined {
  if (!candidate.group) return undefined;
  const omittedCaptureIds = reason ? candidate.group.captureIds : candidate.omittedCaptureIds;
  return {
    ...candidate.group,
    captureCount: candidate.group.captureIds.length,
    omittedCaptureCount: omittedCaptureIds.length,
    deliveredCaptureIds: reason ? [] : candidate.captureIds,
    omittedCaptureIds,
    status: reason
      ? groupUnavailable(candidate.captureIds, delivery)
        ? "unavailable"
        : "not-delivered"
      : "delivered",
    reason,
  };
}

function orderedCaptures(
  captures: readonly unknown[],
  subjectDigest: string,
  preferredReferences: readonly string[],
) {
  const preferred = new Map([...new Set(preferredReferences)].map((id, index) => [id, index]));
  const rank = (capture: ProductReviewCapture) =>
    preferred.get(capture.id) ?? preferred.get(capture.path) ?? preferred.size;
  const identities = new Map<string, string>();
  const conflicts = new Set<string>();
  const parsed = captures.flatMap((capture, index) => {
    const result = captureSchema.safeParse(capture);
    if (!result.success) return [];
    const identity = hashValue(result.data);
    const previous = identities.get(result.data.id);
    if (previous !== undefined && previous !== identity) conflicts.add(result.data.id);
    identities.set(result.data.id, identity);
    return [{ capture: result.data, index }];
  });
  parsed.sort(
    (a, b) =>
      Number(b.capture.subjectDigest === subjectDigest) -
        Number(a.capture.subjectDigest === subjectDigest) ||
      rank(a.capture) - rank(b.capture) ||
      (Date.parse(b.capture.createdAt) || 0) - (Date.parse(a.capture.createdAt) || 0) ||
      b.index - a.index,
  );
  const valid: ProductReviewCapture[] = [];
  const ids = new Set<string>();
  for (const { capture } of parsed) {
    if (!ids.has(capture.id) && !conflicts.has(capture.id)) {
      valid.push(capture);
      ids.add(capture.id);
    }
  }
  return { valid, conflicts };
}

async function readImageBytes(workspace: WorkspaceState, path: string) {
  const metadata = await workspace.files.metadata?.(path);
  if (
    metadata &&
    (!metadata.ok ||
      !metadata.value ||
      metadata.value.type !== "file" ||
      metadata.value.size > 4 * 1024 * 1024)
  )
    return undefined;
  const bytes = await workspace.files.readBytesIfExists(path);
  return bytes.ok ? bytes.value : undefined;
}

/** Inspect one bounded image at a time, retaining only metadata until groups are selected. */
async function inspectCaptureAvailability(
  workspace: WorkspaceState,
  subjectDigest: string,
  capture: ProductReviewCapture,
): Promise<ProductImageAvailability> {
  if (capture.subjectDigest !== subjectDigest)
    return {
      id: capture.id,
      status: "stale",
      reason: "capture describes a different product version",
    };
  let byteLength = 0;
  const inspected = await inspectReviewImages({
    subjectDigest,
    captures: [capture],
    readBytes: async (path) => {
      const bytes = await readImageBytes(workspace, path);
      byteLength = bytes?.length ?? 0;
      return bytes;
    },
  });
  return inspected.images.length
    ? {
        id: capture.id,
        status: "not-delivered",
        byteLength,
        reason: "Intact current image not selected for this bounded delivery",
      }
    : {
        id: capture.id,
        status: "unavailable",
        reason:
          byteLength > 4 * 1024 * 1024
            ? "image exceeds the 4 MiB inspection limit; integrity unassessed"
            : (inspected.gaps[0]?.slice(capture.id.length + 2) ?? "image unavailable"),
      };
}
