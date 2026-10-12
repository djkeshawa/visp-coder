import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { imageDimensions, imageMimeType } from "../evidence/observations/media.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { readImageBytes } from "./images.js";
import type { ProductCheck } from "./model.js";

/** The size and formats the review packet delivers; a larger image would never reach the reviewer. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface CheckImages {
  readonly captures: ProductReviewCapture[];
  readonly mutations: FileMutation[];
}

/**
 * A visual result (a rendered scene, a chart, a generated picture) is judged by looking at it.
 * After a command check passes, the images it declares are copied into the feature's captures
 * as images of this product version, so the review packet delivers them to the reviewer. A
 * declared image that is missing, too large or not an image fails the check: the check
 * promised an output it did not produce.
 */
export async function recordCheckImages(
  workspace: WorkspaceState,
  feature: string,
  check: ProductCheck,
  subjectDigest: string,
  command: string,
): Promise<CheckImages | string> {
  const captures: ProductReviewCapture[] = [];
  const mutations: FileMutation[] = [];
  for (const path of check.images ?? []) {
    const bytes = await readImageBytes(workspace, path);
    if (!bytes) return `Declared image ${path} is missing or larger than 4 MiB after the check ran`;
    const buffer = Buffer.from(bytes);
    const mimeType = imageMimeType(buffer);
    const dimensions = imageDimensions(buffer);
    if (!mimeType || !dimensions || buffer.length > MAX_IMAGE_BYTES)
      return `Declared image ${path} is not a PNG, JPEG, WebP or GIF image VISP can deliver`;
    const id = `CAP-${randomUUID()}`;
    const copy = join(
      workspace.paths.featureDir(feature),
      "captures",
      `${id}.${mimeType.split("/")[1]}`,
    );
    mutations.push({
      kind: "write",
      path: copy,
      content: buffer,
      expectedBefore: { existed: false },
      mode: 0o600,
    });
    captures.push({
      id,
      path: relative(workspace.paths.root, copy).replace(/\\/g, "/"),
      sha256: sha256(buffer),
      subjectDigest,
      route: `check ${check.id}: ${path}`,
      steps: [command],
      viewport: dimensions,
      createdAt: new Date().toISOString(),
      provenance: "runner-captured",
    });
  }
  return { captures, mutations };
}

/** Declared check images are outputs, not product source: rewriting one does not change the product. */
export function declaredCheckImages(checks: readonly ProductCheck[] | undefined): Set<string> {
  return new Set(
    (checks ?? []).flatMap((check) =>
      (check.images ?? []).map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "")),
    ),
  );
}
