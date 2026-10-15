import { ok, type Result } from "../../core/result.js";
import { isStatePath, type WorkspaceState } from "../state.js";
import { inheritedFiles } from "./inherited-record.js";
import { readSourceEntry, sourceEntryHash } from "./source-entry.js";

/**
 * Uncommitted work a feature starts from because Git could not be written to commit it.
 * Scope and evidence are judged on content, so the files themselves need no special
 * treatment; the record (inherited-record.ts) lets the tools that read Git's working-tree
 * changes (guard, the review document, input warnings) tell the earlier work from what the
 * feature changed further.
 */
const FILE_BYTES = 64 * 1024 * 1024;
const TOTAL_BYTES = 512 * 1024 * 1024;

/** Identity of the file's current content, or undefined when it cannot be identified. */
async function contentIdentity(
  workspace: WorkspaceState,
  path: string,
  budget: { bytes: number },
): Promise<string | undefined> {
  const entry = await readSourceEntry(
    workspace.files,
    path,
    Math.min(FILE_BYTES, TOTAL_BYTES - budget.bytes),
  );
  if (!entry.ok) return undefined;
  budget.bytes += entry.value.bytes?.byteLength ?? 0;
  return sourceEntryHash(entry.value.bytes, entry.value.mode, entry.value.symlink);
}

/**
 * Path to content identity of the files changed at feature start. A file that cannot be
 * identified is left out, so it is attributed to the feature rather than hidden from it.
 */
export async function captureInheritedChanges(
  workspace: WorkspaceState,
  paths: readonly string[],
): Promise<Result<Record<string, string>>> {
  const budget = { bytes: 0 };
  const files: Record<string, string> = {};
  for (const path of [...paths].sort()) {
    if (isStatePath(path)) continue;
    const identity = await contentIdentity(workspace, path, budget);
    if (identity !== undefined) files[path] = identity;
  }
  return ok(files);
}

/**
 * Inherited files whose content is still what the feature started from. An unreadable or
 * malformed record inherits nothing, which attributes every change to the feature.
 */
export async function unchangedInheritedPaths(
  workspace: WorkspaceState,
  feature: string | undefined,
): Promise<Set<string>> {
  const files = await inheritedFiles(workspace, feature);
  const budget = { bytes: 0 };
  const unchanged = new Set<string>();
  for (const [path, recorded] of Object.entries(files))
    if ((await contentIdentity(workspace, path, budget)) === recorded) unchanged.add(path);
  return unchanged;
}
