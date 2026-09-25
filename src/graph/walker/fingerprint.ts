import { hashValue } from "../../core/hash.js";
import type { FileEntry } from "../types.js";

/**
 * A stable identity for a worktree's content. Two walks of the same bytes
 * produce the same fingerprint regardless of walk order or machine.
 */
export function worktreeFingerprint(files: readonly FileEntry[]): string {
  const pairs = files
    .map((file) => [file.path, file.hash] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return hashValue(pairs);
}
