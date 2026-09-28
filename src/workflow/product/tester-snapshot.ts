import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { ProductBrief } from "./model.js";
import { readSourceEntry, sourceEntryHash } from "./source-entry.js";
import { productSourceSnapshot } from "./subject.js";

export interface TesterSnapshot {
  readonly root: string;
  dispose(): Promise<void>;
}

// Match the product evidence input budget; never pin against a silently partial copy.
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BYTES = 512 * 1024 * 1024;

/** Exact launch-time bytes, modes and local links, without changing the index or worktree. */
export async function captureTesterSnapshot(
  workspace: WorkspaceState,
  brief: ProductBrief,
  expectedDigest: string,
): Promise<Result<TesterSnapshot>> {
  const source = await productSourceSnapshot(workspace, brief);
  if (!source.ok) return source;
  if (hashValue(source.value) !== expectedDigest) return changedSource();
  const root = await mkdtemp(join(tmpdir(), "visp-tester-source-"));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const copied = await copySources(workspace, source.value, root);
    if (!copied.ok) {
      await dispose();
      return copied;
    }
    const stable = await verifySourceBytes(workspace, copied.value);
    if (!stable.ok) {
      await dispose();
      return stable;
    }
    const after = await productSourceSnapshot(workspace, brief);
    if (!after.ok || hashValue(after.value) !== expectedDigest) {
      await dispose();
      return after.ok ? changedSource() : after;
    }
    return ok({ root, dispose });
  } catch (cause) {
    await dispose();
    return err(vispError("COMMAND_FAILED", `Could not capture tester sources: ${String(cause)}`));
  }
}

function changedSource() {
  return err(
    vispError(
      "STATE_BUSY",
      "Product sources changed while capturing the tester's launch snapshot; retry before implementation",
    ),
  );
}

async function copySources(
  workspace: WorkspaceState,
  source: Record<string, string>,
  root: string,
) {
  const paths = Object.keys(source);
  if (paths.length > MAX_ENTRIES)
    return err(vispError("UNSUPPORTED", "Tester source snapshot exceeds 20000 entries"));
  let bytes = 0;
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === ".." || part === ".git"))
      return err(vispError("UNSUPPORTED", `Unsafe tester source path: ${path}`));
    const entry = await readSourceEntry(
      workspace.files,
      path,
      Math.min(MAX_FILE_BYTES, MAX_BYTES - bytes),
    );
    if (!entry.ok) return entry;
    const hash = sourceEntryHash(entry.value.bytes, entry.value.mode, entry.value.symlink);
    // A clean Git object may normalize CRLF or apply a clean filter. Verify actual working
    // bytes separately instead of confusing that object with the executable launch copy.
    if (!source[path]?.startsWith("git:") && hash !== source[path]) return changedSource();
    hashes[path] = hash;
    if (entry.value.bytes === undefined) continue;
    bytes += entry.value.bytes.byteLength;
    const written = await writeEntry(workspace.paths.root, root, path, {
      ...entry.value,
      bytes: entry.value.bytes,
    });
    if (!written.ok) return written;
  }
  return ok(hashes);
}

async function writeEntry(
  project: string,
  root: string,
  path: string,
  entry: { bytes: Uint8Array; mode?: number; symlink: boolean },
) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  if (entry.symlink) {
    const link = localLink(project, path, Buffer.from(entry.bytes).toString());
    if (!link.ok) return link;
    await symlink(link.value, target);
  } else {
    await writeFile(target, entry.bytes);
    await chmod(target, entry.mode ?? 0o644);
  }
  return ok(undefined);
}

async function verifySourceBytes(workspace: WorkspaceState, hashes: Record<string, string>) {
  for (const [path, hash] of Object.entries(hashes)) {
    const entry = await readSourceEntry(workspace.files, path, MAX_FILE_BYTES);
    if (!entry.ok) return entry;
    if (sourceEntryHash(entry.value.bytes, entry.value.mode, entry.value.symlink) !== hash)
      return changedSource();
  }
  return ok(undefined);
}

/** Absolute links within the checkout must also resolve inside the disposable copy. */
function localLink(root: string, path: string, link: string): Result<string> {
  const target = resolve(root, dirname(path), link);
  const local = relative(root, target);
  if (
    isAbsolute(local) ||
    local === ".." ||
    local.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    local.split(/[\\/]/).some((part) => part === ".git" || part === ".visp")
  )
    return err(vispError("UNSUPPORTED", `Tester snapshot cannot isolate symlink ${path}`));
  return ok(relative(dirname(resolve(root, path)), target) || ".");
}

/** Each execution starts fresh, including the existing-behavior check and repair attempt. */
export async function inTesterSnapshot<T>(
  snapshot: TesterSnapshot,
  execute: (root: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "visp-tester-baseline-"));
  try {
    const root = join(directory, "repository");
    await cp(snapshot.root, root, { recursive: true, verbatimSymlinks: true });
    return await execute(root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
