import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FileMutation } from "../../core/file-transaction.js";
import { rasterizeSvg } from "../../testing/svg-raster.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { declaredCheckImages } from "./check-image-paths.js";
import { imageCapture } from "./check-images.js";
import { captureSchema, readImageBytes } from "./images.js";
import type { ProductRecord } from "./store.js";

const PICTURE = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const MAX_RESULT_IMAGES = 4;
const MAX_SVG_BYTES = 1024 * 1024;
const ROUTE = "result image: ";

/**
 * A picture the product makes (a rendered scene, a chart, a vector drawing) is judged by
 * looking at it. Workers declared such an output on a check in 1 of 6 visual runs, so the
 * reviewer saw source and a "core file unavailable" note instead of the picture. After the
 * checks pass on an unchanged product, the newest product images written since the feature
 * started become review captures of this version: at most four, each once per version. An
 * SVG is rendered in a fresh browser, since reviewers can view PNG files but not SVG ones.
 * Declared check images are captured by their check; nothing here can fail a check.
 */
export async function recordResultImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  subjectDigest: string,
): Promise<{ captures: ProductReviewCapture[]; mutations: FileMutation[] }> {
  const captures: ProductReviewCapture[] = [];
  const mutations: FileMutation[] = [];
  const candidates = await resultImagePaths(workspace, record, snapshot, subjectDigest);
  for (const path of candidates) {
    const bytes = await resultImageBytes(workspace, path);
    const capture = bytes
      ? imageCapture(workspace, record.brief.feature, bytes, subjectDigest, {
          route: `${ROUTE}${path}`,
          steps: [
            path.toLowerCase().endsWith(".svg")
              ? `VISP rendered the product's ${path} in a browser`
              : `VISP read the product's ${path}`,
          ],
        })
      : undefined;
    if (!capture) continue;
    captures.push(capture.capture);
    mutations.push(capture.mutation);
  }
  return { captures, mutations };
}

/** The newest uncaptured product images written since the feature started. */
async function resultImagePaths(
  workspace: WorkspaceState,
  record: ProductRecord,
  snapshot: Record<string, string>,
  subjectDigest: string,
): Promise<string[]> {
  const started = Date.parse(record.state.createdAt);
  if (!Number.isFinite(started)) return [];
  const declared = declaredCheckImages(record.brief.checks);
  const captured = new Set(
    record.state.captures.flatMap((entry) => {
      const capture = captureSchema.safeParse(entry);
      return capture.success && capture.data.subjectDigest === subjectDigest
        ? [capture.data.route]
        : [];
    }),
  );
  const candidates: { path: string; modified: number }[] = [];
  for (const path of Object.keys(snapshot)) {
    if (!PICTURE.test(path) || declared.has(path) || captured.has(`${ROUTE}${path}`)) continue;
    const stats = await lstat(join(workspace.paths.root, path)).catch(() => undefined);
    if (stats?.isFile() && stats.mtimeMs >= started)
      candidates.push({ path, modified: stats.mtimeMs });
  }
  return candidates
    .sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))
    .slice(0, MAX_RESULT_IMAGES)
    .map((entry) => entry.path);
}

async function resultImageBytes(workspace: WorkspaceState, path: string) {
  const bytes = await readImageBytes(workspace, path);
  if (!bytes) return undefined;
  if (!path.toLowerCase().endsWith(".svg")) return Buffer.from(bytes);
  if (bytes.length > MAX_SVG_BYTES) return undefined;
  return rasterizeSvg(bytes);
}
