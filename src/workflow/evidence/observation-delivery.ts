import { sha256 } from "../../core/hash.js";
import { ok, type Result } from "../../core/result.js";
import type { ObservationAttachment, ObservationView } from "../artifacts/observations.js";
import type { WorkspaceState } from "../state.js";
import { imageDimensions, imageMimeType } from "./observations/media.js";
import { readObservationViews } from "./observations.js";

export interface ObservationImage {
  readonly observation: string;
  readonly path: string;
  readonly mimeType: string;
  readonly data: string;
}
export interface ObservationBundle {
  readonly observations: ObservationView[];
  readonly images: ObservationImage[];
  readonly omitted: string[];
}

/** Deliver actual images, not just paths. Delivery never changes a judgment or grants a pass. */
export async function observationBundle(
  state: WorkspaceState,
  feature: string,
  criterion: string,
  task?: string,
): Promise<Result<ObservationBundle>> {
  const views = await readObservationViews(state, feature, task);
  if (!views.ok) return views;
  const observations = views.value.filter((view) => view.criterion === criterion);
  const images: ObservationImage[] = [],
    omitted: string[] = [];
  let remaining = 8 * 1024 * 1024;
  for (const observation of observations) {
    for (const attachment of observation.attachments) {
      const path = attachment.storedPath;
      if (images.length >= 6) {
        omitted.push(`${path}: unavailable or exceeds image delivery limits`);
        continue;
      }
      const loaded = await loadImage(state, attachment, remaining);
      if (typeof loaded === "string") {
        omitted.push(`${path}: ${loaded}`);
        continue;
      }
      images.push({
        observation: observation.id,
        path,
        mimeType: loaded.mimeType,
        data: loaded.buffer.toString("base64"),
      });
      remaining -= loaded.buffer.length;
    }
  }
  return ok({ observations, images, omitted });
}

async function loadImage(
  state: WorkspaceState,
  attachment: ObservationAttachment,
  remaining: number,
): Promise<{ buffer: Buffer; mimeType: string } | string> {
  const path = attachment.storedPath;
  const metadata = await state.files.metadata(path);
  const size = metadata.ok ? metadata.value?.size : undefined;
  if (imageTooLarge(size, remaining)) return "unavailable or exceeds image delivery limits";
  const bytes = await state.files.readBytes(path);
  if (
    !bytes.ok ||
    bytes.value.length > Math.min(remaining, 4 * 1024 * 1024) ||
    sha256(bytes.value) !== attachment.sha256
  ) {
    return "unavailable, too large, or changed since capture";
  }
  const buffer = Buffer.from(bytes.value);
  const mimeType = imageMimeType(buffer);
  if (!mimeType || !imageDimensions(buffer)) {
    return "not a supported still image; extract frames from video for inspection";
  }
  return { buffer, mimeType };
}

function imageTooLarge(size: number | undefined, remaining: number): boolean {
  return size === undefined || size > Math.min(remaining, 4 * 1024 * 1024);
}
