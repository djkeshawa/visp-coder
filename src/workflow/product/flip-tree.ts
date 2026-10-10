import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { run } from "../../core/exec.js";
import { removeTreeBestEffort } from "../../core/stale-temp.js";
import type { WorkspaceState } from "../state.js";
import {
  type FlipEnvironment,
  projectNeedles,
  provideFlipEnvironment,
  type RootNeedles,
  relocatedBytes,
  sweepStaleFlipTemporary,
} from "./flip-environment.js";
import { baselineMode, baselineObjects } from "./review-diff.js";
import type { ProductAuthorization } from "./scopes.js";
import { MISSING_SOURCE_ENTRY, readSourceEntry, sourceEntryHash } from "./source-entry.js";

export interface FlipEntry {
  bytes?: Uint8Array;
  mode?: number;
  symlink?: boolean;
}
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

/** Recover only bytes matching VISP's recorded identity, including dirty baseline overlays. */
export async function recoverFlipBaseline(workspace: WorkspaceState, auth: ProductAuthorization) {
  const paths = Object.keys(auth.baseline).sort();
  const objects = await baselineObjects(
    workspace.paths.root,
    paths.map((path) => {
      const identity = auth.baseline[path];
      return identity?.startsWith("git:")
        ? identity.split(":")[2]
        : auth.headCommit
          ? `${auth.headCommit}:${path}`
          : undefined;
    }),
  );
  const entries = new Map<string, FlipEntry>();
  for (const [index, path] of paths.entries()) {
    const identity = auth.baseline[path];
    if (identity === MISSING_SOURCE_ENTRY) {
      entries.set(path, {});
      continue;
    }
    const old = objects[index];
    const recovered = recoverObject(old, identity);
    if (recovered) {
      entries.set(path, recovered);
      continue;
    }
    const current = await readSourceEntry(workspace.files, path, 8 * 1024 * 1024);
    if (
      current.ok &&
      sourceEntryHash(current.value.bytes, current.value.mode, current.value.symlink) === identity
    )
      entries.set(path, current.value);
  }
  return entries;
}

/** The scratch checkout is disposable; no restore operation ever targets the user's checkout. */
export async function inFlipTree<T>(
  workspace: WorkspaceState,
  auth: ProductAuthorization,
  baseline: ReadonlyMap<string, FlipEntry>,
  preserved: ReadonlySet<string>,
  snapshot: Record<string, string>,
  execute: (directory: string) => Promise<T>,
  environment?: FlipEnvironment,
): Promise<T> {
  if (!auth.headCommit) throw new Error("work-authorization head commit unavailable");
  await sweepStaleFlipTemporary();
  const directory = await mkdtemp(join(tmpdir(), "visp-product-flip-"));
  const tree = join(directory, "tree");
  try {
    const added = await run(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", tree, auth.headCommit],
      { cwd: workspace.paths.root, env: GIT_ENV, timeoutMs: 30000 },
    );
    if (!added.ok || added.value.exitCode !== 0)
      throw new Error("could not create reverted worktree");
    await provideFlipEnvironment(workspace.paths.root, tree, environment);
    const needles = await projectNeedles(workspace.paths.root);
    await populateFlipTree(workspace, auth, baseline, preserved, snapshot, tree, needles);
    return await execute(tree);
  } finally {
    // Do not propagate a check's cancellation to cleanup.
    let retry = false;
    try {
      try {
        await removeFlipWorktree(workspace.paths.root, tree);
      } catch {
        retry = true;
      }
    } finally {
      try {
        await removeTreeBestEffort(directory);
      } finally {
        if (retry) await removeFlipWorktree(workspace.paths.root, tree);
      }
    }
  }
}

async function currentEntry(workspace: WorkspaceState, path: string): Promise<FlipEntry> {
  const entry = await readSourceEntry(workspace.files, path, 8 * 1024 * 1024);
  if (!entry.ok) throw new Error(`validation bytes unavailable for ${path}`);
  return entry.value;
}

/** What an overlay writes is relocated as a copied file is: the project's root names the comparison. */
interface Relocation {
  project: string;
  needles: RootNeedles;
}

async function overlay(root: string, path: string, entry: FlipEntry, relocation: Relocation) {
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => part === ".." || part === ".git") ||
    /[\0\r\n\\]/.test(path)
  )
    throw new Error(`unsupported baseline path ${JSON.stringify(path)}`);
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const stat = await lstat(parent).catch(() => undefined);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(`unsafe overlay parent for ${path}`);
    if (!stat) await mkdir(parent);
  }
  const target = join(root, path);
  await rm(target, { force: true });
  if (entry.bytes === undefined) return;
  await mkdir(dirname(target), { recursive: true });
  if (entry.symlink) {
    await overlaySymlink(root, target, path, entry.bytes, relocation.project);
  } else {
    await writeFile(
      target,
      relocatedBytes(path, entry.bytes, relocation.needles, Buffer.from(root)),
    );
    await chmod(target, entry.mode ?? 0o644);
  }
}

async function populateFlipTree(
  workspace: WorkspaceState,
  auth: ProductAuthorization,
  baseline: ReadonlyMap<string, FlipEntry>,
  preserved: ReadonlySet<string>,
  snapshot: Record<string, string>,
  tree: string,
  needles: RootNeedles,
) {
  for (const path of new Set([...Object.keys(auth.baseline), ...Object.keys(snapshot)])) {
    const entry = preserved.has(path)
      ? await currentEntry(workspace, path)
      : (baseline.get(path) ?? (auth.baseline[path] === undefined ? {} : undefined));
    if (!entry) throw new Error(`baseline bytes unavailable for ${path}`);
    await overlay(tree, path, entry, { project: workspace.paths.root, needles });
  }
}
function recoverObject(
  bytes: Buffer | undefined,
  identity: string | undefined,
): FlipEntry | undefined {
  if (!bytes || !identity) return undefined;
  const mode = baselineMode(bytes, identity);
  if (mode !== undefined) return { bytes, mode };
  const linkMode = baselineMode(bytes, identity, true);
  return linkMode === undefined ? undefined : { bytes, mode: linkMode, symlink: true };
}

async function removeFlipWorktree(root: string, tree: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const removed = await run("git", ["worktree", "remove", "--force", "--force", tree], {
      cwd: root,
      env: GIT_ENV,
      timeoutMs: 30000,
    });
    if (removed.ok && removed.value.exitCode === 0) return;
    const listed = await run("git", ["worktree", "list", "--porcelain"], {
      cwd: root,
      env: GIT_ENV,
      timeoutMs: 30000,
    });
    // Creation can fail after registration. Also attempt removal in that case, but an
    // unregistered tree is safe to remove from disk without pruning anyone else's entries.
    if (
      listed.ok &&
      listed.value.exitCode === 0 &&
      !listed.value.stdout.split("\n").includes(`worktree ${tree}`)
    )
      return;
  }
  throw new Error(`could not clean up reverted worktree ${tree}`);
}

async function overlaySymlink(
  root: string,
  target: string,
  path: string,
  bytes: Uint8Array,
  project: string,
) {
  let link = Buffer.from(bytes).toString("utf8");
  if (isAbsolute(link)) {
    const local = relative(project, link);
    if (local.startsWith("..") || isAbsolute(local))
      throw new Error(`external symlink cannot be reproduced safely: ${path}`);
    link = join(root, local);
  }
  if (relative(root, resolve(dirname(target), link)).startsWith(".."))
    throw new Error(`external symlink cannot be reproduced safely: ${path}`);
  await symlink(link, target);
}
