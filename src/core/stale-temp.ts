import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Removes directories that a crashed or killed run left in the temporary directory.
 * Reviewer and tester runs keep a copy of the operator's Codex sign-in there, so an
 * abandoned directory is a credential left on disk. Only real directories directly under
 * `dir` whose name matches one of `names`, owned by the current user and not
 * modified for `maxAgeMs`, are removed; symlinks are never followed. Best effort: a
 * directory that cannot be removed now is tried again by the next sweep.
 */
export async function sweepStaleTempDirectories(
  names: readonly RegExp[],
  maxAgeMs: number,
  dir: string = tmpdir(),
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const owner = process.getuid?.();
  for (const entry of entries) {
    if (!entry.isDirectory() || !names.some((name) => name.test(entry.name))) continue;
    const path = join(dir, entry.name);
    const details = await lstat(path).catch(() => undefined);
    if (!details?.isDirectory() || (owner !== undefined && details.uid !== owner)) continue;
    if (Date.now() - details.mtimeMs <= maxAgeMs) continue;
    await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(
      () => undefined,
    );
  }
}
