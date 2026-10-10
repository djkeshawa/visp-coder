import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkMutationGuard } from "./check-context.js";
import { STATE_DIR } from "./constants.js";
import { fromUnknown, isNodeError, vispError } from "./errors.js";
import { ProjectFileSystem } from "./fs.js";
import { processIdentity } from "./process-identity.js";
import { err, ok, type Result } from "./result.js";

export const STATE_LOCK_DIRECTORY = `${STATE_DIR}/state/mutation.lock`;
const OWNER_FILE = `${STATE_LOCK_DIRECTORY}/owner.json`;
const RECOVERY_DIRECTORY = `${STATE_LOCK_DIRECTORY}.recovery`;
/** A lock directory without owner.json is a live writer for milliseconds; older means it crashed. */
const OWNERLESS_LOCK_MS = 30_000;
/** The recovery mutex is held for milliseconds; an older one belongs to a reclaimer that died. */
const STALE_RECOVERY_MS = 60_000;
const ownerSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    createdAt: z.string().datetime(),
    processStart: z.string().optional(),
    bootId: z.string().optional(),
    pidNamespace: z.string().optional(),
  })
  .strict();
type Owner = z.infer<typeof ownerSchema>;
interface Lease {
  active: boolean;
}
interface Scope {
  readonly lease: Lease;
  readonly parent?: Scope;
  active: boolean;
  children: Promise<void>;
}
const activeTokens = new Set<string>();
const writers = new Map<string, Promise<void>>();
const ownership = new AsyncLocalStorage<ReadonlyMap<string, Scope>>();

/** One mutation owner per canonical worktree, shared by independent CLI/MCP processes. */
export async function withStateLock<T>(
  root: string,
  operation: () => Promise<Result<T>>,
  options: { readonly timeoutMs?: number } = {},
): Promise<Result<T>> {
  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch (cause) {
    return err(fromUnknown(cause, "IO_ERROR"));
  }
  const guarded = await checkMutationGuard(canonical);
  if (guarded) return err(guarded);
  const inherited = ownership.getStore();
  let parent = inherited?.get(canonical);
  while (parent && !parent.active) parent = parent.parent;
  if (parent?.lease.active) return enqueueChild(canonical, inherited, parent, operation);
  if (options.timeoutMs !== undefined)
    return ownLock(canonical, inherited, operation, options.timeoutMs);
  const previous = writers.get(canonical);
  let done!: () => void;
  const pending = new Promise<void>((resolve) => {
    done = resolve;
  });
  writers.set(canonical, pending);
  await previous;
  try {
    return await ownLock(canonical, inherited, operation, 5000);
  } finally {
    done();
    if (writers.get(canonical) === pending) writers.delete(canonical);
  }
}

async function ownLock<T>(
  canonical: string,
  inherited: ReadonlyMap<string, Scope> | undefined,
  operation: () => Promise<Result<T>>,
  timeoutMs: number,
): Promise<Result<T>> {
  const files = new ProjectFileSystem(canonical);
  const acquired = await acquire(files, timeoutMs);
  if (!acquired.ok) return acquired;
  activeTokens.add(acquired.value.token);
  const lease: Lease = { active: true };
  const frame: Scope = { lease, active: true, children: Promise.resolve() };
  let result: Result<T>;
  try {
    result = await runScope(canonical, inherited, frame, operation);
  } finally {
    lease.active = false;
  }
  const released = await release(files, acquired.value);
  activeTokens.delete(acquired.value.token);
  return released.ok ? result : released;
}

async function enqueueChild<T>(
  canonical: string,
  inherited: ReadonlyMap<string, Scope> | undefined,
  parent: Scope,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const previous = parent.children;
  let releaseChild!: () => void;
  parent.children = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  await previous;
  try {
    return await runScope(
      canonical,
      inherited,
      {
        lease: parent.lease,
        parent,
        active: true,
        children: Promise.resolve(),
      },
      operation,
    );
  } finally {
    releaseChild();
  }
}

async function runScope<T>(
  canonical: string,
  inherited: ReadonlyMap<string, Scope> | undefined,
  frame: Scope,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  const scope = new Map(inherited);
  scope.set(canonical, frame);
  try {
    return await ownership.run(scope, operation);
  } catch (cause) {
    return err(fromUnknown(cause));
  } finally {
    // Direct children serialize; each child's descendants retain awaited reentrancy.
    let pending: Promise<void>;
    do {
      pending = frame.children;
      await pending;
    } while (pending !== frame.children);
    frame.active = false;
  }
}

export async function inspectStateLock(root: string): Promise<
  Result<{
    readonly state: "unlocked" | "active" | "abandoned" | "ambiguous";
    readonly owner?: Owner;
  }>
> {
  const files = new ProjectFileSystem(root);
  const exists = await files.exists(STATE_LOCK_DIRECTORY);
  if (!exists.ok) return exists;
  if (!exists.value) return ok({ state: "unlocked" });
  const owner = await readOwner(files);
  if (owner.ok && !owner.value)
    return ok({ state: (await ownerlessAbandoned(files)) ? "abandoned" : "ambiguous" });
  if (!owner.ok || !owner.value) return ok({ state: "ambiguous" });
  return ok({ state: await ownerState(owner.value), owner: owner.value });
}

async function acquire(files: ProjectFileSystem, timeoutMs: number): Promise<Result<Owner>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return err(vispError("IO_ERROR", "State lock timeout must be finite and nonnegative"));
  }
  const owner: Owner = {
    version: 1,
    ...(await processIdentity(process.pid)),
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const created = await createOwner(files, owner);
    if (!created.ok) return created;
    if (created.value) return ok(owner);
    const abandoned = await reclaimAbandoned(files);
    if (!abandoned.ok) return abandoned;
    if (abandoned.value) continue;
    if (performance.now() >= deadline) break;
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
  const current = await readOwner(files);
  return busy(
    "Another writer owns the worktree, or its ownership cannot be established",
    current.ok ? current.value : undefined,
  );
}

async function createOwner(files: ProjectFileSystem, owner: Owner): Promise<Result<boolean>> {
  const ready = await files.ensureDir(`${STATE_DIR}/state`);
  if (!ready.ok) return ready;
  const safe = await files.metadata(STATE_LOCK_DIRECTORY);
  if (!safe.ok) return safe;
  try {
    await mkdir(join(files.root, STATE_LOCK_DIRECTORY), { mode: 0o700 });
  } catch (cause) {
    if (isNodeError(cause) && (cause.code === "EEXIST" || cause.code === "ENOENT"))
      return ok(false);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
  activeTokens.add(owner.token);
  const published = await publishOwner(files, owner);
  if (published.ok && published.value) return ok(true);
  activeTokens.delete(owner.token);
  return published;
}

/** link() errors of filesystems that cannot hard-link; publishing falls back to rename(). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"]);

/**
 * Publishes owner.json exclusively: link() fails when one exists, and nothing here creates the
 * lock directory, so a lock reaped from under us is a retry (false), never a second holder.
 */
async function publishOwner(files: ProjectFileSystem, owner: Owner): Promise<Result<boolean>> {
  const directory = join(files.root, STATE_LOCK_DIRECTORY);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const target = join(directory, "owner.json");
    try {
      await link(temporary, target);
    } catch (cause) {
      if (!(isNodeError(cause) && NO_HARD_LINKS.has(cause.code ?? ""))) throw cause;
      // No hard links here (FAT, some network mounts). rename() replaces instead of failing, so
      // this has the weaker guarantee: an existing owner.json is only checked for beforehand.
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      )
        return ok(false);
      await rename(temporary, target);
    }
    return ok(true);
  } catch (cause) {
    if (isNodeError(cause) && (cause.code === "ENOENT" || cause.code === "EEXIST"))
      return ok(false);
    await unlink(temporary).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
    return err(fromUnknown(cause, "IO_ERROR"));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readOwner(files: ProjectFileSystem): Promise<Result<Owner | undefined>> {
  return files.readJsonIfExists(OWNER_FILE, (value) => {
    const parsed = ownerSchema.safeParse(value);
    return parsed.success ? ok(parsed.data) : busy("State lock owner is malformed");
  });
}

async function ownerState(owner: Owner): Promise<"active" | "abandoned" | "ambiguous"> {
  if (owner.host !== hostname()) return "ambiguous";
  const identity = await processIdentity(owner.pid);
  if (owner.bootId && identity.bootId && owner.bootId !== identity.bootId) return "abandoned";
  if (owner.pidNamespace && identity.pidNamespace !== owner.pidNamespace) return "ambiguous";
  if (owner.processStart && identity.processStart && owner.processStart !== identity.processStart)
    return "abandoned";
  if (owner.pid === process.pid && !activeTokens.has(owner.token))
    return owner.pidNamespace ? "abandoned" : "ambiguous";
  try {
    process.kill(owner.pid, 0);
    return "active";
  } catch (cause) {
    return isNodeError(cause) && cause.code === "ESRCH" ? "abandoned" : "ambiguous";
  }
}

export async function recoverStateLock(root: string, token: string): Promise<Result<boolean>> {
  const files = new ProjectFileSystem(root);
  const guarded = await checkMutationGuard(root);
  if (guarded) return err(guarded);
  const observed = await readOwner(files);
  if (!observed.ok) return observed;
  if (!observed.value || observed.value.token !== token)
    return busy(
      "State lock owner changed; inspect it again before confirming recovery",
      observed.value,
    );
  if ((await ownerState(observed.value)) === "active")
    return busy(
      "The confirmed owner is still active; cancel that operation before recovering",
      observed.value,
    );
  return reclaimAbandoned(files, token);
}

async function reclaimAbandoned(
  files: ProjectFileSystem,
  confirmedToken?: string,
): Promise<Result<boolean>> {
  const observed = await readOwner(files);
  if (!observed.ok) return ok(false);
  const owner = observed.value;
  if (!(owner ? await recoverable(owner, confirmedToken) : await ownerlessAbandoned(files)))
    return ok(false);
  const held = await takeRecoveryMutex(files);
  if (!held.ok || !held.value) return held;
  try {
    // A second reclaimer must not unlink a new owner's lock after the first succeeds.
    const current = await readOwner(files);
    if (!current.ok) return current;
    if (!owner) return current.value ? ok(false) : removeOwnerlessLock(files);
    if (current.value?.token !== owner.token || !(await recoverable(current.value, confirmedToken)))
      return ok(false);
    const removed = await files.removeFile(OWNER_FILE);
    if (!removed.ok) return removed;
    const directory = await files.removeDir(STATE_LOCK_DIRECTORY);
    return directory.ok ? ok(true) : directory;
  } finally {
    await files.removeDir(RECOVERY_DIRECTORY);
  }
}

/** Whether this caller now holds the recovery mutex; a mutex left by a dead reclaimer is cleared. */
async function takeRecoveryMutex(files: ProjectFileSystem): Promise<Result<boolean>> {
  const safe = await files.metadata(RECOVERY_DIRECTORY);
  if (!safe.ok) return safe;
  try {
    await mkdir(join(files.root, RECOVERY_DIRECTORY), { mode: 0o700 });
    return ok(true);
  } catch (cause) {
    if (!(isNodeError(cause) && cause.code === "EEXIST"))
      return err(fromUnknown(cause, "IO_ERROR"));
    await clearStaleRecoveryMutex(files);
    // The acquire loop retries once the stale mutex is gone.
    return ok(false);
  }
}

async function clearStaleRecoveryMutex(files: ProjectFileSystem): Promise<void> {
  const seen = await snapshot(files, RECOVERY_DIRECTORY);
  if (!seen || Date.now() - seen.mtimeMs <= STALE_RECOVERY_MS) return;
  // Only the directory that was judged stale is removed. What remains is the gap between this
  // lstat and the rmdir: a live reclaimer that took the mutex in that gap loses it. That needs a
  // 60 s old mutex to be replaced within microseconds, and the lock owner is re-checked by every
  // reclaimer under the mutex, so it is accepted.
  if (sameDirectory(seen, await snapshot(files, RECOVERY_DIRECTORY)))
    await rmdir(join(files.root, RECOVERY_DIRECTORY)).catch(() => undefined);
}

/**
 * Only called under the recovery mutex. Unlinks the interrupted-write leftovers the aged
 * directory was judged by, never a listing taken later (a just-published owner.json must
 * survive), and treats a directory that changed or filled meanwhile as "not abandoned".
 */
async function removeOwnerlessLock(files: ProjectFileSystem): Promise<Result<boolean>> {
  const found = await abandonedOwnerless(files);
  if (!found) return ok(false);
  const safe = await files.metadata(STATE_LOCK_DIRECTORY);
  if (!safe.ok) return safe;
  for (const name of found.names) {
    const removed = await files.removeFile(`${STATE_LOCK_DIRECTORY}/${name}`);
    if (!removed.ok) return removed;
  }
  // The unlinks changed the directory's mtime, so identity is the inode here. A fresh directory
  // that reused it is emptied of nothing and its creator, whose publish never makes the directory,
  // simply retries.
  if ((await snapshot(files, STATE_LOCK_DIRECTORY))?.ino !== found.directory.ino) return ok(false);
  try {
    await rmdir(join(files.root, STATE_LOCK_DIRECTORY));
    return ok(true);
  } catch (cause) {
    if (isNodeError(cause) && ["ENOTEMPTY", "EEXIST", "ENOENT"].includes(cause.code ?? ""))
      return ok(false);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

interface DirectorySnapshot {
  readonly ino: number;
  readonly mtimeMs: number;
}

async function snapshot(
  files: ProjectFileSystem,
  path: string,
): Promise<DirectorySnapshot | undefined> {
  try {
    const stats = await lstat(join(files.root, path));
    return stats.isDirectory() ? { ino: stats.ino, mtimeMs: stats.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function sameDirectory(a: DirectorySnapshot | undefined, b: DirectorySnapshot | undefined) {
  return a !== undefined && b !== undefined && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/**
 * The lock directory and its entries when it has no owner.json for longer than any live writer
 * needs and holds at most interrupted writes of it. The directory must exist, and be the same
 * one (inode and mtime) before and after listing: a missing directory lists as empty, and a
 * fresh one created in between must never be judged by the old one's age.
 */
async function abandonedOwnerless(
  files: ProjectFileSystem,
): Promise<{ directory: DirectorySnapshot; names: string[] } | undefined> {
  const before = await snapshot(files, STATE_LOCK_DIRECTORY);
  if (!before || Date.now() - before.mtimeMs <= OWNERLESS_LOCK_MS) return undefined;
  const entries = await files.listDir(STATE_LOCK_DIRECTORY);
  if (!entries.ok || !sameDirectory(before, await snapshot(files, STATE_LOCK_DIRECTORY)))
    return undefined;
  // Anything else in the directory is not ours to judge.
  return entries.value.every((name) => /^\..+\.tmp$/.test(name))
    ? { directory: before, names: entries.value }
    : undefined;
}

async function ownerlessAbandoned(files: ProjectFileSystem): Promise<boolean> {
  return (await abandonedOwnerless(files)) !== undefined;
}

async function recoverable(owner: Owner, confirmedToken?: string) {
  const state = await ownerState(owner);
  return state === "abandoned" || (state === "ambiguous" && owner.token === confirmedToken);
}

async function release(files: ProjectFileSystem, owner: Owner): Promise<Result<void>> {
  const current = await readOwner(files);
  if (!current.ok) return current;
  if (current.value?.token !== owner.token)
    return busy("State mutation ownership changed before release");
  const removed = await files.removeFile(OWNER_FILE);
  if (!removed.ok) return removed;
  const directory = await files.removeDir(STATE_LOCK_DIRECTORY);
  if (!directory.ok) return directory;
  // Contenders prepare these shared parents before taking ownership; cleanup races their mkdir.
  return ok(undefined);
}

function busy(message: string, owner?: Owner): Result<never> {
  return err(
    vispError("STATE_BUSY", message, {
      recovery:
        "Retain and poll the original host command/session handle; a yielded command may still own this lock. " +
        "Wait for it to finish or cancel that session before retrying. PIDs can repeat across sandboxes; " +
        "do not delete a lock based only on its PID or age. Inspect ownership before recovering an ambiguous lock.",
      details: { lock: STATE_LOCK_DIRECTORY, ...(owner ? { owner } : {}) },
    }),
  );
}
