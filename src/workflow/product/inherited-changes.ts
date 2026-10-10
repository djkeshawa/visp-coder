import { z } from "zod";
import { ok, type Result } from "../../core/result.js";
import { isStatePath, type WorkspaceState } from "../state.js";
import { readSourceEntry, sourceEntryHash } from "./source-entry.js";

/**
 * Uncommitted work a feature starts from because Git could not be written to commit it,
 * as in Codex's workspace-write sandbox. Scope and evidence are judged on content, so the
 * files themselves need no special treatment; this record lets the tools that read Git's
 * working-tree changes (guard, the review document, input warnings) tell the earlier work
 * from what the feature changed further. It is machine-local, like the authorization.
 */
const inheritedChangesSchema = z
  .object({ version: z.literal(1), files: z.record(z.string()) })
  .strict();

const FILE_BYTES = 64 * 1024 * 1024;
const TOTAL_BYTES = 512 * 1024 * 1024;

export const inheritedChangesPath = (workspace: WorkspaceState, feature: string): string =>
  workspace.paths.stateFile(`state/inherited-changes/${feature}.json`);

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

export function inheritedChangesContent(files: Record<string, string>): string {
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

/**
 * Inherited files whose content is still what the feature started from. An unreadable or
 * malformed record inherits nothing, which attributes every change to the feature.
 */
export async function unchangedInheritedPaths(
  workspace: WorkspaceState,
  feature: string | undefined,
): Promise<Set<string>> {
  if (!feature) return new Set();
  const text = await workspace.files.readTextIfExists(inheritedChangesPath(workspace, feature));
  if (!text.ok || text.value === undefined) return new Set();
  let parsed: ReturnType<typeof inheritedChangesSchema.safeParse>;
  try {
    parsed = inheritedChangesSchema.safeParse(JSON.parse(text.value));
  } catch {
    return new Set();
  }
  if (!parsed.success) return new Set();
  const budget = { bytes: 0 };
  const unchanged = new Set<string>();
  for (const [path, recorded] of Object.entries(parsed.data.files))
    if ((await contentIdentity(workspace, path, budget)) === recorded) unchanged.add(path);
  return unchanged;
}
