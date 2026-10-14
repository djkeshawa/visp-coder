import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
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
 * declared image that this run did not write, that is too large or that is not an image fails
 * the check: the check promised an output it did not produce.
 */
export async function recordCheckImages(
  workspace: WorkspaceState,
  feature: string,
  check: ProductCheck,
  subjectDigest: string,
  command: string,
  before: DeclaredImageStates,
): Promise<CheckImages | string> {
  const captures: ProductReviewCapture[] = [];
  const mutations: FileMutation[] = [];
  for (const path of check.images ?? []) {
    const after = await fileState(workspace.paths.root, path);
    if (after === undefined || after === before.get(path))
      return `${check.id} passed but did not write its declared image ${path} in this run; make the check write it`;
    const bytes = await readImageBytes(workspace, path);
    if (!bytes) return `Declared image ${path} is missing or larger than 4 MiB after the check ran`;
    const capture = imageCapture(workspace, feature, Buffer.from(bytes), subjectDigest, {
      route: `check ${check.id}: ${path}`,
      steps: [command],
    });
    if (!capture)
      return `Declared image ${path} is not a PNG, JPEG, WebP or GIF image VISP can deliver`;
    captures.push(capture.capture);
    mutations.push(capture.mutation);
  }
  return { captures, mutations };
}

/** Each declared image's file identity before the check ran; undefined when it did not exist. */
export type DeclaredImageStates = ReadonlyMap<string, string | undefined>;

/**
 * A PNG left from an earlier run, or an existing product file, would otherwise be delivered
 * as this version's picture. Recorded before the command runs; a check passes only when each
 * declared image is new or its file changed (inode, size, modification or change time).
 */
export async function declaredImageStates(
  root: string,
  check: ProductCheck,
): Promise<DeclaredImageStates> {
  const states = new Map<string, string | undefined>();
  for (const path of check.images ?? []) states.set(path, await fileState(root, path));
  return states;
}

async function fileState(root: string, path: string): Promise<string | undefined> {
  const stats = await lstat(join(root, path), { bigint: true }).catch(() => undefined);
  return stats && [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

/** A review capture of one image of this product version, or undefined if VISP cannot deliver it. */
export function imageCapture(
  workspace: WorkspaceState,
  feature: string,
  buffer: Buffer,
  subjectDigest: string,
  origin: { route: string; steps: string[] },
): { capture: ProductReviewCapture; mutation: FileMutation } | undefined {
  const mimeType = imageMimeType(buffer);
  const dimensions = imageDimensions(buffer);
  if (!mimeType || !dimensions || buffer.length > MAX_IMAGE_BYTES) return undefined;
  const id = `CAP-${randomUUID()}`;
  const copy = join(
    workspace.paths.featureDir(feature),
    "captures",
    `${id}.${mimeType.split("/")[1]}`,
  );
  return {
    mutation: {
      kind: "write",
      path: copy,
      content: buffer,
      expectedBefore: { existed: false },
      mode: 0o600,
    },
    capture: {
      id,
      path: relative(workspace.paths.root, copy).replace(/\\/g, "/"),
      sha256: sha256(buffer),
      subjectDigest,
      route: origin.route,
      steps: origin.steps,
      viewport: dimensions,
      createdAt: new Date().toISOString(),
      provenance: "runner-captured",
    },
  };
}
