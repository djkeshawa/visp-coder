import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import type { ProjectFileSystem } from "../../core/fs.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { err, ok } from "../../core/result.js";

export function sourceEntryHash(bytes: Uint8Array | undefined, mode?: number, symlink = false) {
  return hashValue({
    hash: bytes === undefined ? null : sha256(bytes),
    mode,
    ...(symlink ? { type: "symlink" } : {}),
  });
}

/** Snapshot identity of a tracked path with no file behind it (deleted from the working tree). */
export const MISSING_SOURCE_ENTRY = sourceEntryHash(undefined);

export async function readSourceEntry(files: ProjectFileSystem, path: string, maxBytes: number) {
  const link = await files.readSymbolicLink(path);
  if (!link.ok) return link;
  if (link.value !== undefined) return ok({ bytes: link.value, mode: 0o777, symlink: true });
  const metadata = await files.readMetadata(path);
  if (!metadata.ok) return metadata;
  if (metadata.value && metadata.value.type !== "file")
    return err(
      vispError(
        "UNSUPPORTED",
        `Product evidence requires files or symlinks; cannot inspect ${path}`,
      ),
    );
  if ((metadata.value?.size ?? 0) > maxBytes)
    return err(vispError("UNSUPPORTED", `Product evidence input budget exceeded at ${path}`));
  const read = await files.readBytesIfExists(path);
  if (!read.ok) return read;
  if ((read.value?.length ?? 0) > maxBytes)
    return err(vispError("UNSUPPORTED", `Product evidence input budget exceeded at ${path}`));
  return ok({ bytes: read.value, mode: metadata.value?.mode, symlink: false });
}

export function sourceEntryMutation(
  path: string,
  before: { bytes?: Uint8Array; mode?: number; symlink: boolean },
  after: { bytes?: Uint8Array; mode?: number; symlink?: boolean },
): FileMutation {
  const expectedBefore = filePrecondition(before.bytes, before.mode, before.symlink);
  return after.bytes === undefined
    ? { kind: "remove", path, expectedBefore }
    : {
        kind: after.symlink ? "symlink" : "write",
        path,
        content: after.bytes,
        mode: after.mode,
        expectedBefore,
      };
}
