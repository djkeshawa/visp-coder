import { appendFile } from "node:fs/promises";
import { redactStrings } from "../../core/redaction.js";
import type { WorkspaceState } from "../state.js";
import type { SessionActivity } from "./critic-exec.js";

export const TESTER_ACTIVITY_FILE = "tester-activity.jsonl";

/**
 * Monitoring for the tester: one JSON line per session in the feature's directory. With
 * network (execution mode) its commands appear in `visp pr`. Logging never fails the tester.
 */
export async function recordTesterActivity(
  workspace: WorkspaceState,
  feature: string,
  model: string,
  network: boolean,
  activity: SessionActivity,
): Promise<void> {
  const line = `${JSON.stringify(redactStrings({ at: new Date().toISOString(), model, network, ...activity }, workspace.paths.root))}\n`;
  await appendFile(workspace.paths.featureFile(feature, TESTER_ACTIVITY_FILE), line).catch(
    () => undefined,
  );
}

/** Commands the tester ran with network access, per session, oldest first. */
export async function testerNetworkCommands(
  workspace: WorkspaceState,
  feature: string,
): Promise<{ at: string; commands: string[] }[]> {
  const text = await workspace.files.readTextIfExists(
    workspace.paths.featureFile(feature, TESTER_ACTIVITY_FILE),
  );
  if (!text.ok || !text.value) return [];
  return text.value.split("\n").flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { at?: string; network?: boolean; commands?: string[] };
      return entry.network && entry.commands?.length
        ? [{ at: entry.at ?? "", commands: entry.commands }]
        : [];
    } catch {
      return [];
    }
  });
}
