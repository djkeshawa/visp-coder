import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
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
/** The model API refuses an image larger than this on either side, so it is never delivered. */
const MAX_IMAGE_SIDE = 8000;

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
    const after = await fileStats(workspace.paths.root, path);
    if (!after || identity(after) === before.get(path))
      return `${check.id} passed but did not write its declared image ${path} in this run; make the check write it`;
    const bytes = after.isFile() ? await readImageBytes(workspace, path) : undefined;
    const problem = declaredImageProblem(after, bytes && Buffer.from(bytes));
    if (problem || !bytes) return `${check.id}'s declared image ${path} ${problem ?? UNREADABLE}`;
    const capture = imageCapture(workspace, feature, Buffer.from(bytes), subjectDigest, {
      route: `check ${check.id}: ${path}`,
      steps: [command],
    });
    if (!capture) return `${check.id}'s declared image ${path} ${UNREADABLE}`;
    captures.push(capture.capture);
    mutations.push(capture.mutation);
  }
  return { captures, mutations };
}

const UNREADABLE = "could not be read inside the project; make the check write it there";

/** Why VISP cannot deliver a declared image, and what the check should do instead. */
function declaredImageProblem(stats: BigIntStats, bytes: Buffer | undefined): string | undefined {
  if (!stats.isFile())
    return "is a symbolic link or not a regular file; make the check write the image file itself";
  if (stats.size > MAX_IMAGE_BYTES)
    return "is larger than 4 MiB; make the check write a smaller image";
  if (!bytes) return undefined;
  const dimensions = imageDimensions(bytes);
  if (!imageMimeType(bytes) || !dimensions)
    return "is not a PNG, JPEG, WebP or GIF file; make the check write one of those formats";
  return deliverableSize(dimensions)
    ? undefined
    : `is ${dimensions.width}×${dimensions.height} pixels; make the check write one at most ${MAX_IMAGE_SIDE} pixels on each side`;
}

function deliverableSize(dimensions: { width: number; height: number }): boolean {
  return dimensions.width <= MAX_IMAGE_SIDE && dimensions.height <= MAX_IMAGE_SIDE;
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
  for (const path of check.images ?? []) {
    const stats = await fileStats(root, path);
    states.set(path, stats && identity(stats));
  }
  return states;
}

function fileStats(root: string, path: string): Promise<BigIntStats | undefined> {
  return lstat(join(root, path), { bigint: true }).catch(() => undefined);
}

function identity(stats: BigIntStats): string {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

/**
 * A review capture of one image of this product version, or undefined if VISP cannot deliver
 * it: not one of the formats, over 4 MiB or over 8000 pixels on a side.
 */
export function imageCapture(
  workspace: WorkspaceState,
  feature: string,
  buffer: Buffer,
  subjectDigest: string,
  origin: { route: string; steps: string[] },
): { capture: ProductReviewCapture; mutation: FileMutation } | undefined {
  const mimeType = imageMimeType(buffer);
  const dimensions = imageDimensions(buffer);
  if (!mimeType || !dimensions || !deliverableSize(dimensions) || buffer.length > MAX_IMAGE_BYTES)
    return undefined;
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
