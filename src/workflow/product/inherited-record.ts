import { z } from "zod";
import type { WorkspaceState } from "../state.js";

/**
 * Uncommitted work a feature starts from because Git could not be written to commit it,
 * as in Codex's workspace-write sandbox: path to content identity at feature start. It is
 * machine-local, like the authorization. Kept apart from the readers that hash current
 * content, so the source snapshot can read it without importing workspace state.
 */
const inheritedChangesSchema = z
  .object({ version: z.literal(1), files: z.record(z.string()) })
  .strict();

export const inheritedChangesPath = (workspace: WorkspaceState, feature: string): string =>
  workspace.paths.stateFile(`state/inherited-changes/${feature}.json`);

export function inheritedChangesContent(files: Record<string, string>): string {
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

/** The recorded files; an unreadable or malformed record inherits nothing. */
export async function inheritedFiles(
  workspace: WorkspaceState,
  feature: string | undefined,
): Promise<Record<string, string>> {
  if (!feature) return {};
  const text = await workspace.files.readTextIfExists(inheritedChangesPath(workspace, feature));
  if (!text.ok || text.value === undefined) return {};
  try {
    const parsed = inheritedChangesSchema.safeParse(JSON.parse(text.value));
    return parsed.success ? parsed.data.files : {};
  } catch {
    return {};
  }
}

/** Paths the feature started from uncommitted, changed since or not. */
export async function inheritedPaths(
  workspace: WorkspaceState,
  feature: string | undefined,
): Promise<Set<string>> {
  return new Set(Object.keys(await inheritedFiles(workspace, feature)));
}
