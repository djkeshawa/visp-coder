import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import type { UiCapture } from "./contract.js";

export const CAPTURE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const CAPTURE_LIMIT = 200;
const MAX_DEPTH = 5;
const MAX_CAPTURE_BYTES = 25_000_000;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const capturesDir = (featureDir: string) => join(featureDir, "captures");

/** Images under the feature's captures, newest first. Symlinks are never followed. */
export async function listCaptures(featureDir: string): Promise<UiCapture[]> {
  const found: UiCapture[] = [];
  await walk(capturesDir(featureDir), [], found);
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, CAPTURE_LIMIT);
}

async function walk(dir: string, segments: string[], found: UiCapture[]): Promise<void> {
  if (segments.length > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(join(dir, ...segments), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!SAFE_SEGMENT.test(entry.name)) continue;
    const path = [...segments, entry.name];
    if (entry.isDirectory()) await walk(dir, path, found);
    else if (entry.isFile() && CAPTURE_TYPES[extname(entry.name).toLowerCase()]) {
      const info = await lstat(join(dir, ...path)).catch(() => undefined);
      if (info?.isFile())
        found.push({
          path: path.join("/"),
          name: entry.name,
          modifiedAt: info.mtime.toISOString(),
        });
    }
  }
}

export type CaptureRead =
  | { readonly ok: true; readonly body: Buffer; readonly contentType: string }
  | { readonly ok: false; readonly status: 400 | 404 | 413 };

/**
 * Reads one capture by its relative path. Every segment must be a plain name, no
 * segment may be a symlink, and the file is opened without following links and
 * checked to be the same file that was inspected, so a swap between the check
 * and the read is refused rather than served.
 */
export async function readCapture(featureDir: string, relative: string): Promise<CaptureRead> {
  const segments = relative.split("/");
  const contentType = CAPTURE_TYPES[extname(relative).toLowerCase()];
  if (
    !contentType ||
    segments.length > MAX_DEPTH + 1 ||
    segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === "." || segment === "..")
  )
    return { ok: false, status: 400 };
  const root = capturesDir(featureDir);
  for (let index = 1; index <= segments.length; index++) {
    const info = await lstat(join(root, ...segments.slice(0, index))).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return { ok: false, status: 404 };
  }
  const path = join(root, ...segments);
  if (!path.startsWith(root + sep)) return { ok: false, status: 400 };
  const before = await lstat(path);
  if (!before.isFile()) return { ok: false, status: 404 };
  if (before.size > MAX_CAPTURE_BYTES) return { ok: false, status: 413 };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (!handle) return { ok: false, status: 404 };
  try {
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isFile())
      return { ok: false, status: 404 };
    return { ok: true, body: await handle.readFile(), contentType };
  } finally {
    await handle.close();
  }
}
