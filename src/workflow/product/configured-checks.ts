import { resolveCommand } from "../../core/exec.js";
import { hashValue } from "../../core/hash.js";
import type { WorkspaceState } from "../state.js";
import type { ProductCheck } from "./model.js";
import type { ProductRecord } from "./store.js";

/** A worker cannot opt its own check into configured-check treatment by naming it CONFIG_n. */
export function isConfiguredCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  check: ProductCheck,
): boolean {
  if (record.brief.checks.some((entry) => entry.id === check.id)) return false;
  const match = /^CONFIG_([1-9]\d*)$/.exec(check.id);
  const command = match && workspace.config.workflow.validationCommands[Number(match[1]) - 1];
  return !!command && hashValue(command) === hashValue(check.command);
}

export function configuredMissingTool(
  check: ProductCheck,
  output: string,
  exitCode: number,
): string | undefined {
  const missing =
    /(?:^|\n)[^\n]*?([^\s:]+):\s*(?:command )?not found\b/im.exec(output)?.[1] ??
    /Missing script:\s*["']?([^"'\s]+)/i.exec(output)?.[1] ??
    /missing-command:\s*"([^"]+)"/i.exec(output)?.[1];
  if (missing) return missing;
  if (exitCode !== 127) return undefined;
  const argv = resolveCommand(check.command as string | string[]);
  return argv.ok ? argv.value[0] : undefined;
}

export function configuredToolRecovery(check: ProductCheck, tool: string): string {
  return `missing-command: ${JSON.stringify(tool)} is unavailable for ${check.id}. Install it (or restore the missing npm script), or remove/replace this command in visp.yml workflow.validationCommands, then run visp done. No product behavior was tested.`;
}
