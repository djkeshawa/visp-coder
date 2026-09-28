import { sha256 } from "../../core/hash.js";
import { imageDimensions, imageMimeType } from "./observations/media.js";

/** Capturing pixels records an observation; it never supplies the reviewer judgment. */
export interface ProductReviewCapture {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly subjectDigest: string;
  readonly route: string;
  readonly steps: readonly string[];
  /** Position in the run's full operation log; steps are a bounded local summary. */
  readonly operationIndex?: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly createdAt: string;
  readonly provenance: "runner-captured" | "agent-supplied";
}

export interface ProductReviewImage extends ProductReviewCapture {
  readonly mimeType: string;
  readonly data: string;
}

export interface ProductReviewImages {
  readonly images: ProductReviewImage[];
  readonly gaps: string[];
}

/** The caller supplies a repository-confined reader; paths alone are never review evidence. */
export async function inspectReviewImages(options: {
  readonly subjectDigest: string;
  readonly captures: readonly ProductReviewCapture[];
  readonly readBytes: (path: string) => Promise<Uint8Array | undefined>;
}): Promise<ProductReviewImages> {
  const images: ProductReviewImage[] = [],
    gaps: string[] = [];
  let remaining = 8 * 1024 * 1024;
  for (const capture of options.captures) {
    if (capture.subjectDigest !== options.subjectDigest) {
      gaps.push(`${capture.id}: capture describes a different product version`);
      continue;
    }
    if (images.length >= 6) {
      gaps.push(`${capture.id}: image delivery limit reached`);
      continue;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = await options.readBytes(capture.path);
    } catch {
      bytes = undefined;
    }
    const loaded = inspectImage(capture, bytes, remaining);
    if (typeof loaded === "string") {
      gaps.push(`${capture.id}: ${loaded}`);
      continue;
    }
    images.push({ ...capture, mimeType: loaded.mimeType, data: loaded.bytes.toString("base64") });
    remaining -= loaded.bytes.length;
  }
  if (!images.length) gaps.push("No intact image of the current product is available for review");
  return { images, gaps };
}

function inspectImage(
  capture: ProductReviewCapture,
  input: Uint8Array | undefined,
  remaining: number,
) {
  if (!input || input.length > Math.min(remaining, 4 * 1024 * 1024))
    return "image is missing or exceeds delivery size limits";
  if (sha256(input) !== capture.sha256) return "image changed since capture";
  const bytes = Buffer.from(input),
    dimensions = imageDimensions(bytes);
  const mimeType = imageMimeType(bytes);
  if (!dimensions || !mimeType) return "unsupported or invalid image";
  if (!capture.route.trim() || !capture.steps.some((step) => step.trim()))
    return "capture has no route or interaction journey";
  if (capture.viewport.width <= 0 || capture.viewport.height <= 0)
    return "capture has no usable viewport";
  return { bytes, mimeType };
}
