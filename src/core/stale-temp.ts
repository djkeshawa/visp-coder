import { chmod, lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "./process-identity.js";

/**
 * Removes directories that a crashed or killed run left in the temporary directory.
 * Reviewer and tester runs keep a copy of the operator's Codex sign-in there, so an
 * abandoned directory is a credential left on disk; `sweepAbandonedCredentialHomes`
 * removes that copy sooner, once its owner has ended. Only real directories directly under
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
    await removeTreeBestEffort(path);
  }
}

/**
 * Removes a directory VISP made for a run, whatever the run left in it: a read-only
 * directory (a Go module cache, a test that dropped write permission) would make a plain
 * `rm` fail with EACCES. Directories are made writable first; whatever still cannot be
 * removed is left for a later sweep. Never throws, so cleanup cannot change a result.
 */
export async function removeTreeBestEffort(path: string): Promise<void> {
  await makeWritable(path, 0).catch(() => undefined);
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  );
}

async function makeWritable(path: string, depth: number): Promise<void> {
  const details = await lstat(path);
  if (!details.isDirectory() || depth > 64) return;
  await chmod(path, details.mode | 0o700);
  for (const entry of await readdir(path)) await makeWritable(join(path, entry), depth + 1);
}

/** Names the process that made a directory, inside it. */
const OWNER_FILE = ".visp-owner.json";
/** VISP's temporary run directories: a `visp-` prefix plus `mkdtemp`'s six characters. */
const VISP_TEMPORARY = /^visp-[a-z-]+-[A-Za-z0-9]{6}$/u;
/** Where reviewer and tester runs keep their private copy of the Codex sign-in. */
const CREDENTIAL_HOME = "codex-home";

/** Records which process owns `directory`, so a sweep can tell once that process is gone. */
export async function markOwner(directory: string, pid = process.pid): Promise<void> {
  await writeFile(
    join(directory, OWNER_FILE),
    JSON.stringify({ pid, ...(await processIdentity(pid)) }),
    { mode: 0o600 },
  );
}

/**
 * Removes the private Codex sign-in copies (`codex-home`) that a SIGKILLed reviewer or tester
 * left in VISP's temporary directories, as soon as the process that made them has ended: the
 * age-based sweep would keep the credential for an hour. A copy whose owner may still run, or
 * that names no owner, is left to that sweep. Best effort; never throws.
 */
export async function sweepAbandonedCredentialHomes(dir: string = tmpdir()): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const owner = process.getuid?.();
  for (const entry of entries) {
    if (!entry.isDirectory() || !VISP_TEMPORARY.test(entry.name)) continue;
    const home = join(dir, entry.name, CREDENTIAL_HOME);
    const details = await lstat(home).catch(() => undefined);
    if (!details?.isDirectory() || (owner !== undefined && details.uid !== owner)) continue;
    if (await ownerEnded(home)) await removeTreeBestEffort(home);
  }
}

async function ownerEnded(directory: string): Promise<boolean> {
  let recorded: { pid?: unknown; processStart?: unknown; bootId?: unknown };
  try {
    recorded = JSON.parse(await readFile(join(directory, OWNER_FILE), "utf8"));
  } catch {
    return false;
  }
  const pid = recorded.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return false;
  const current = await processIdentity(pid);
  if (recorded.bootId && current.bootId && recorded.bootId !== current.bootId) return true;
  // The PID was reused by a process that started later.
  if (
    recorded.processStart &&
    current.processStart &&
    recorded.processStart !== current.processStart
  )
    return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ESRCH";
  }
}
