import { vispError } from "./errors.js";
import { run } from "./exec.js";
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
  // Git may hide edits behind these index flags; they are not an evidence exemption.
  const flags = await gitOutput(root, ["ls-files", "-v", "-z"]);
  if (!flags.ok) return flags;
  for (const line of flags.value.split("\0")) {
    if (/^[a-zS] /.test(line)) dirty.add(line.slice(2));
  }
  return ok({ entries, dirty });
}

/** Git streams large regular files without loading their bytes into VISP. No object is written. */
export async function workingFileObject(root: string, path: string): Promise<Result<string>> {
  const result = await gitOutput(root, ["hash-object", "--no-filters", "--", path]);
  return result.ok ? ok(result.value.trim()) : result;
}
