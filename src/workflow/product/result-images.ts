import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { sha256 } from "../../core/hash.js";
import { type SvgRasterizer, svgRasterizer } from "../../testing/svg-raster.js";
import type { ProductReviewCapture } from "../evidence/product-review.js";
import type { WorkspaceState } from "../state.js";
import { declaredCheckImages } from "./check-image-paths.js";
import { imageCapture } from "./check-images.js";
import { captureSchema, readImageBytes } from "./images.js";
import type { ProductExecution } from "./model.js";
import type { ProductRecord } from "./store.js";

const PICTURE = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const MAX_RESULT_IMAGES = 4;
const MAX_SVG_BYTES = 1024 * 1024;
const ROUTE = "result image: ";
/** SVG contents a working browser could not render; machine-local, like check output logs. */
const UNRENDERED_FILE = "unrendered-svg.json";
const MAX_UNRENDERED = 200;

interface ResultPicture {
  readonly capture: ProductReviewCapture;
  readonly mutation: FileMutation;
}

/** Pictures read and rendered before VISP takes the state lock. */
export interface PreparedResultImages {
  /** The product version the pictures were read from; publication requires it unchanged. */
  readonly subjectDigest?: string;
  readonly pictures: readonly ResultPicture[];
  /** SHA-256 of SVG contents that did not render in a working browser. */
  readonly unrendered: readonly string[];
}

const NONE: PreparedResultImages = { pictures: [], unrendered: [] };

/**
 * A picture the product makes (a rendered scene, a chart, a vector drawing) is judged by
 * looking at it. Workers declared such an output on a check in 1 of 6 visual runs, so the
 * reviewer saw source and a "core file unavailable" note instead of the picture. After the
 * checks pass, the newest product images written since the feature started become review
 * captures of this version: at most four, each once per version. An SVG is rendered in a
 * browser, since reviewers can view PNG files but not SVG ones. Declared check images are
 * captured by their check; nothing here can fail a check.
 *
 * Starting a browser takes seconds and other VISP processes give up on the state lock after
 * 5 s, so the pictures are read and rendered here, before the lock, in one shared browser;
 * an SVG that does not render is remembered by content and not tried again.
 * publishResultImages keeps them only if the product is still the version they were read from.
 */
export async function prepareResultImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  executions: readonly ProductExecution[],
  source: { readonly digest: string; readonly snapshot: Record<string, string> },
): Promise<PreparedResultImages> {
  if (!executions.length || executions.some((execution) => execution.status !== "passed"))
    return NONE;
  const candidates = await resultImagePaths(workspace, record, source.snapshot, source.digest);
  if (!candidates.length) return NONE;
  const svgs = new SvgRendering(await unrenderedSvgs(workspace));
  const pictures: ResultPicture[] = [];
  try {
    for (const path of candidates) {
      const bytes = await resultImageBytes(workspace, path, svgs);
      const picture = bytes
        ? imageCapture(workspace, record.brief.feature, bytes, source.digest, {
            route: `${ROUTE}${path}`,
            steps: [
              path.toLowerCase().endsWith(".svg")
                ? `VISP rendered the product's ${path} in a browser`
                : `VISP read the product's ${path}`,
            ],
          })
        : undefined;
      if (picture) pictures.push(picture);
    }
  } finally {
    await svgs.close();
  }
  return { subjectDigest: source.digest, pictures, unrendered: svgs.unrendered };
}

/**
 * Under the state lock: the prepared pictures, if the product is still the version they were
 * read from and no other run captured them meanwhile, and the remembered unrendered SVGs.
 */
export async function publishResultImages(
  workspace: WorkspaceState,
  record: ProductRecord,
  prepared: PreparedResultImages,
  subjectDigest: string,
): Promise<{ captures: ProductReviewCapture[]; mutations: FileMutation[] }> {
  const captured = capturedRoutes(record, subjectDigest);
  const pictures =
    prepared.subjectDigest === subjectDigest
      ? prepared.pictures.filter((picture) => !captured.has(picture.capture.route))
      : [];
  return {
    captures: pictures.map((picture) => picture.capture),
    mutations: [
      ...pictures.map((picture) => picture.mutation),
      ...(await unrenderedMutation(workspace, prepared.unrendered)),
    ],
  };
}

function capturedRoutes(record: ProductRecord, subjectDigest: string): Set<string> {
  return new Set(
    record.state.captures.flatMap((entry) => {
      const capture = captureSchema.safeParse(entry);
      return capture.success && capture.data.subjectDigest === subjectDigest
        ? [capture.data.route]
        : [];
    }),
  );
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
  const captured = capturedRoutes(record, subjectDigest);
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

async function resultImageBytes(workspace: WorkspaceState, path: string, svgs: SvgRendering) {
  const bytes = await readImageBytes(workspace, path);
  if (!bytes) return undefined;
  if (!path.toLowerCase().endsWith(".svg")) return Buffer.from(bytes);
  return bytes.length > MAX_SVG_BYTES ? undefined : svgs.render(bytes);
}

/**
 * One browser for a run's SVGs, started on the first one not already known not to render;
 * after the browser fails, the run's other SVGs are skipped.
 */
class SvgRendering {
  readonly unrendered: string[] = [];
  private rasterizer: SvgRasterizer | undefined;
  private browserFailed = false;

  constructor(private readonly known: ReadonlySet<string>) {}

  async render(svg: Uint8Array): Promise<Buffer | undefined> {
    const digest = sha256(svg);
    if (this.browserFailed || this.known.has(digest)) return undefined;
    this.rasterizer ??= svgRasterizer();
    const rendered = await this.rasterizer.render(svg);
    if ("png" in rendered) return rendered.png;
    if (rendered.failed === "picture") this.unrendered.push(digest);
    else this.browserFailed = true;
    return undefined;
  }

  async close(): Promise<void> {
    await this.rasterizer?.close();
  }
}

function unrenderedPath(workspace: WorkspaceState): string {
  return join(workspace.paths.sessionDir, UNRENDERED_FILE);
}

function parseUnrendered(text: string | undefined): string[] {
  try {
    const parsed = text === undefined ? undefined : (JSON.parse(text) as { sha256?: unknown });
    return Array.isArray(parsed?.sha256)
      ? parsed.sha256.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

async function unrenderedSvgs(workspace: WorkspaceState): Promise<Set<string>> {
  const text = await workspace.files.readTextIfExists(unrenderedPath(workspace));
  return new Set(text.ok ? parseUnrendered(text.value) : []);
}

async function unrenderedMutation(
  workspace: WorkspaceState,
  unrendered: readonly string[],
): Promise<FileMutation[]> {
  if (!unrendered.length) return [];
  const path = unrenderedPath(workspace);
  const existing = await workspace.files.readTextIfExists(path);
  if (!existing.ok) return [];
  const merged = [...new Set([...parseUnrendered(existing.value), ...unrendered])].slice(
    -MAX_UNRENDERED,
  );
  return [
    {
      kind: "write",
      path,
      content: `${JSON.stringify({ version: 1, sha256: merged })}\n`,
      mode: 0o600,
      expectedBefore: filePrecondition(existing.value),
    },
  ];
}
