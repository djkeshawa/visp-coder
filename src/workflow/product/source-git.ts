import type { GitSourceEntry } from "../../core/git-source.js";
import { workingSourceObject } from "../../core/git-source.js";
import { ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { sourceEntryHash } from "./source-entry.js";

export const gitSourceIdentity = (entry: GitSourceEntry) => `git:${entry.mode}:${entry.object}`;

export function repositorySourceIdentity(
  workspace: WorkspaceState,
  path: string,
  objects: { entries: Map<string, GitSourceEntry>; dirty: Set<string> },
  algorithm: "sha1" | "sha256",
) {
  const cached = objects.entries.get(path);
  return cached && !objects.dirty.has(path)
    ? Promise.resolve(ok(gitSourceIdentity(cached)))
    : workingSourceIdentity(workspace, path, algorithm);
}

/** Only declared inputs need byte snapshots; other files use Git's content identity. */
async function workingSourceIdentity(
  workspace: WorkspaceState,
  path: string,
  algorithm: "sha1" | "sha256",
) {
  const entry = await workingSourceObject(workspace.files, path, algorithm);
  return entry.ok
    ? ok(entry.value ? gitSourceIdentity(entry.value) : sourceEntryHash(undefined))
    : entry;
}
