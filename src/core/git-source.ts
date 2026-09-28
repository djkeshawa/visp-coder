import { createHash } from "node:crypto";
import { vispError } from "./errors.js";
import { run } from "./exec.js";
import type { ProjectFileSystem } from "./fs.js";
import { err, ok, type Result } from "./result.js";

export interface GitSourceEntry {
  mode: string;
  object: string;
}

async function gitOutput(root: string, args: string[]): Promise<Result<string>> {
  const result = await run("git", args, {
    cwd: root,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  if (!result.ok) return result;
  return result.value.exitCode === 0
    ? ok(result.value.stdout)
    : err(vispError("COMMAND_FAILED", "Could not inspect Git source identity"));
}

/** Reuse Git objects only where the index and working tree agree. */
export async function repositorySourceObjects(root: string) {
  const indexed = await gitOutput(root, ["ls-files", "--stage", "-z"]);
  if (!indexed.ok) return indexed;
  const entries = new Map<string, GitSourceEntry>();
  const dirty = new Set<string>();
  for (const line of indexed.value.split("\0")) {
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(line);
    if (!match) continue;
    const [, mode = "", object = "", stage, path = ""] = match;
    entries.set(path, { mode, object });
    if (stage !== "0") dirty.add(path);
  }
  const changed = await gitOutput(root, ["diff-files", "--name-only", "--no-renames", "-z", "--"]);
  if (!changed.ok) return changed;
  for (const path of changed.value.split("\0")) if (path) dirty.add(path);
  const flags = await flaggedSourcePaths(root);
  if (!flags.ok) return flags;
  for (const path of flags.value) dirty.add(path);
  return ok({ entries, dirty });
}

/** Git streams large regular files without loading their bytes into VISP. No object is written. */
async function workingFileObject(root: string, path: string): Promise<Result<string>> {
  const result = await gitOutput(root, ["hash-object", "--no-filters", "--", path]);
  return result.ok ? ok(result.value.trim()) : result;
}

/** Git index flags are not proof that a working file is unchanged. */
export async function flaggedSourcePaths(root: string): Promise<Result<Set<string>>> {
  const flags = await gitOutput(root, ["ls-files", "-v", "-z"]);
  if (!flags.ok) return flags;
  return ok(
    new Set(
      flags.value
        .split("\0")
        .filter((line) => /^[a-zS] /.test(line))
        .map((line) => line.slice(2)),
    ),
  );
}

export async function headSourceObjects(
  root: string,
  paths: string[],
): Promise<Result<Map<string, GitSourceEntry>>> {
  const tree = await gitOutput(root, [
    "ls-tree",
    "-rz",
    "HEAD",
    "--",
    ...paths.map((path) => `:(literal)${path}`),
  ]);
  if (!tree.ok) return tree;
  const entries = new Map<string, GitSourceEntry>();
  for (const line of tree.value.split("\0")) {
    const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (match?.[1] && match[2] && match[3])
      entries.set(match[3], { mode: match[1], object: match[2] });
  }
  return ok(entries);
}

export async function workingSourceObject(
  files: ProjectFileSystem,
  path: string,
  algorithm: "sha1" | "sha256",
): Promise<Result<GitSourceEntry | undefined>> {
  const link = await files.readSymbolicLink(path);
  if (!link.ok) return link;
  if (link.value !== undefined) {
    const object = createHash(algorithm)
      .update(`blob ${link.value.length}\0`)
      .update(link.value)
      .digest("hex");
    return ok({ mode: "120000", object });
  }
  const metadata = await files.readMetadata(path);
  if (!metadata.ok) return metadata;
  if (!metadata.value) return ok(undefined);
  if (metadata.value.type !== "file")
    return err(vispError("UNSUPPORTED", `Unsupported source entry: ${path}`));
  const object = await workingFileObject(files.root, path);
  return object.ok
    ? ok({ mode: metadata.value.mode & 0o111 ? "100755" : "100644", object: object.value })
    : object;
}
