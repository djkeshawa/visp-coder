import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { checkMutationGuard } from "./check-context.js";
import { STATE_DIR } from "./constants.js";
import { fromUnknown, isNodeError, vispError } from "./errors.js";
import { ProjectFileSystem } from "./fs.js";
import { err, ok, type Result } from "./result.js";

export const STATE_LOCK_DIRECTORY = `${STATE_DIR}/state/mutation.lock`;
const OWNER_FILE = `${STATE_LOCK_DIRECTORY}/owner.json`;
const RECOVERY_DIRECTORY = `${STATE_LOCK_DIRECTORY}.recovery`;
const ownerSchema = z
  .object({
    version: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    createdAt: z.string().datetime(),
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
  const files = new ProjectFileSystem(canonical);
  const acquired = await acquire(files, options.timeoutMs ?? 5_000);
  if (!acquired.ok) return acquired;
  const lease: Lease = { active: true };
  const frame: Scope = { lease, active: true, children: Promise.resolve() };
  let result: Result<T>;
  try {
    result = await runScope(canonical, inherited, frame, operation);
  } finally {
    lease.active = false;
  }
  const released = await release(files, acquired.value);
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
  if (!owner.ok || !owner.value) return ok({ state: "ambiguous" });
  return ok({ state: ownerState(owner.value), owner: owner.value });
}

async function acquire(files: ProjectFileSystem, timeoutMs: number): Promise<Result<Owner>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return err(vispError("IO_ERROR", "State lock timeout must be finite and nonnegative"));
  }
  const owner: Owner = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    createdAt: new Date().toISOString(),
  };
  const deadline = performance.now() + timeoutMs;
  do {
    const created = await createOwner(files, owner);
    if (!created.ok) return created;
    if (created.value) return ok(owner);
    const abandoned = await reclaimAbandoned(files);
    if (!abandoned.ok) return abandoned;
    if (abandoned.value) continue;
    if (performance.now() >= deadline) break;
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  } while (performance.now() <= deadline);
  return busy("Another writer owns the worktree, or its ownership cannot be established");
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
  const written = await files.writeJson(OWNER_FILE, owner, 0o600);
  if (!written.ok) {
    await files.removeDir(STATE_LOCK_DIRECTORY);
    return written;
  }
  return ok(true);
}

async function readOwner(files: ProjectFileSystem): Promise<Result<Owner | undefined>> {
  return files.readJsonIfExists(OWNER_FILE, (value) => {
    const parsed = ownerSchema.safeParse(value);
    return parsed.success ? ok(parsed.data) : busy("State lock owner is malformed");
  });
}

function ownerState(owner: Owner): "active" | "abandoned" | "ambiguous" {
  if (owner.host !== hostname()) return "ambiguous";
  try {
    process.kill(owner.pid, 0);
    return "active";
  } catch (cause) {
    return isNodeError(cause) && cause.code === "ESRCH" ? "abandoned" : "ambiguous";
  }
}

async function reclaimAbandoned(files: ProjectFileSystem): Promise<Result<boolean>> {
  const observed = await readOwner(files);
  if (!observed.ok || !observed.value || ownerState(observed.value) !== "abandoned")
    return ok(false);
  const safe = await files.metadata(RECOVERY_DIRECTORY);
  if (!safe.ok) return safe;
  try {
    await mkdir(join(files.root, RECOVERY_DIRECTORY), { mode: 0o700 });
  } catch (cause) {
    return isNodeError(cause) && cause.code === "EEXIST"
      ? ok(false)
      : err(fromUnknown(cause, "IO_ERROR"));
  }
  try {
    // A second reclaimer must not unlink a new owner's lock after the first succeeds.
    const current = await readOwner(files);
    if (!current.ok) return current;
    if (current.value?.token !== observed.value.token || ownerState(current.value) !== "abandoned")
      return ok(false);
    const removed = await files.removeFile(OWNER_FILE);
    if (!removed.ok) return removed;
    const directory = await files.removeDir(STATE_LOCK_DIRECTORY);
    return directory.ok ? ok(true) : directory;
  } finally {
    await files.removeDir(RECOVERY_DIRECTORY);
  }
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

function busy(message: string): Result<never> {
  return err(
    vispError("STATE_BUSY", message, {
      recovery:
        "Retain and poll the original host command/session handle; a yielded command may still own this lock. " +
        "Wait for it to finish or cancel that session before retrying. PIDs can repeat across sandboxes; " +
        "do not delete a lock based only on its PID or age. Inspect ownership before recovering an ambiguous lock.",
      details: { lock: STATE_LOCK_DIRECTORY },
    }),
  );
}
