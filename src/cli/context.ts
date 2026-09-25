import { resolve } from "node:path";
import type { Command } from "commander";
import { parseFeatureId, parseTaskId } from "../core/input.js";
import type { Result } from "../core/result.js";
import {
  loadWorkspace,
  loadWorkspaceForMutation,
  resolveFeature,
  type WorkspaceState,
} from "../workflow/state.js";

/** Options every command accepts, declared once on the root program. */
export interface GlobalOptions {
  readonly project?: string;
  readonly json?: boolean;
}

/** A command's own options merged with the root program's globals. */
export function options<T>(command: Command): GlobalOptions & T {
  return command.optsWithGlobals() as GlobalOptions & T;
}

export function projectRoot(options: GlobalOptions): string {
  return resolve(options.project ?? process.cwd());
}

export function isJson(options: GlobalOptions): boolean {
  return options.json === true;
}

export async function workspace(options: GlobalOptions): Promise<Result<WorkspaceState>> {
  return loadWorkspace(projectRoot(options));
}

/** Recovers abandoned transactions before loading any state used to plan a mutation. */
export async function mutatingWorkspace(options: GlobalOptions): Promise<Result<WorkspaceState>> {
  return loadWorkspaceForMutation(projectRoot(options));
}

/** Loads the workspace and resolves the feature a command should act on. */
export async function workspaceWithFeature(
  options: GlobalOptions & { feature?: string; task?: string },
): Promise<Result<{ state: WorkspaceState; feature: string }>> {
  const valid = validateArtifactSelection(options);
  if (!valid.ok) return valid;

  const state = await workspace(options);
  if (!state.ok) return state;

  const feature = resolveFeature(state.value, options.feature);
  if (!feature.ok) return feature;

  return { ok: true, value: { state: state.value, feature: feature.value } };
}

/** Validates user-supplied path-bearing identifiers before any command can use them. */
export function validateArtifactSelection(options: {
  feature?: string;
  task?: string;
}): Result<void> {
  if (options.feature !== undefined) {
    const feature = parseFeatureId(options.feature);
    if (!feature.ok) return feature;
  }
  if (options.task !== undefined) {
    const task = parseTaskId(options.task);
    if (!task.ok) return task;
  }
  return { ok: true, value: undefined };
}
