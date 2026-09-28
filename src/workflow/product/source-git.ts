import { createHash } from "node:crypto";
import { vispError } from "../../core/errors.js";
import type { GitSourceEntry } from "../../core/git-source.js";
import { workingFileObject } from "../../core/git-source.js";
import { err, ok } from "../../core/result.js";
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
  const link = await workspace.files.readSymbolicLink(path);
  if (!link.ok) return link;
  if (link.value !== undefined) {
    const object = createHash(algorithm)
      .update(`blob ${link.value.length}\0`)
      .update(link.value)
      .digest("hex");
    return ok(gitSourceIdentity({ mode: "120000", object }));
  }
  const metadata = await workspace.files.readMetadata(path);
  if (!metadata.ok) return metadata;
  if (!metadata.value) return ok(sourceEntryHash(undefined));
  if (metadata.value.type !== "file")
    return err(vispError("UNSUPPORTED", `Unsupported source entry: ${path}`));
  const object = await workingFileObject(workspace.paths.root, path);
  return object.ok
    ? ok(
        gitSourceIdentity({
          mode: metadata.value.mode & 0o111 ? "100755" : "100644",
          object: object.value,
        }),
      )
    : object;
}
