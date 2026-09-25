import { parseFeatureId } from "../core/input.js";
import { ok, type Result } from "../core/result.js";
import {
  loadWorkspace,
  loadWorkspaceForMutation,
  resolveFeature,
  type WorkspaceState,
} from "../workflow/state.js";

/**
 * The MCP equivalent of `src/cli/context.ts`: one place that turns a project
 * root into the state a tool acts on, so tools never re-read `.visp/`.
 */
export interface FeatureScope {
  readonly state: WorkspaceState;
  readonly feature: string;
}

export async function workspaceFor(root: string): Promise<Result<WorkspaceState>> {
  return loadWorkspace(root);
}

export async function mutatingWorkspaceFor(root: string): Promise<Result<WorkspaceState>> {
  return loadWorkspaceForMutation(root);
}

export async function featureScope(root: string, feature?: string): Promise<Result<FeatureScope>> {
  if (feature !== undefined) {
    const checked = parseFeatureId(feature);
    if (!checked.ok) return checked;
  }
  const state = await workspaceFor(root);
  if (!state.ok) return state;

  const resolved = resolveFeature(state.value, feature);
  if (!resolved.ok) return resolved;

  return ok({ state: state.value, feature: resolved.value });
}
