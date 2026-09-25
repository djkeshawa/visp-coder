import { createHash } from "node:crypto";
import type { ProjectFileSystem } from "../../core/fs.js";
import { BINARY_SNIFF_BYTES } from "../constants.js";
import { languageForPath } from "../paths.js";
import type { FileEntry, SkipReason } from "../types.js";

export type FileInspection =
  | { readonly kind: "file"; readonly entry: FileEntry }
  | { readonly kind: "skipped"; readonly reason: SkipReason };

export async function inspectFile(
  files: ProjectFileSystem,
  path: string,
  repoPath: string,
  bytes: number,
  maxFileBytes: number,
): Promise<FileInspection> {
  if (bytes > maxFileBytes) return { kind: "skipped", reason: "too_large" };

  const read = await files.readBytes(path);
  if (!read.ok) return { kind: "skipped", reason: "unreadable" };
  const contents = Buffer.from(read.value);

  if (looksBinary(contents)) return { kind: "skipped", reason: "binary" };

  return {
    kind: "file",
    entry: {
      path: repoPath,
      bytes: contents.byteLength,
      hash: hashBytes(contents),
      language: languageForPath(repoPath),
    },
  };
}

/** A NUL in the first block is the same signal `git` uses to call a file binary. */
export function looksBinary(contents: Buffer): boolean {
  return contents.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export function hashBytes(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}
