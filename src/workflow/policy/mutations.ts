import { withStateMutation } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import {
  loadWorkspace,
  loadWorkspaceForMutation,
  saveOverrides,
  savePolicy,
  type WorkspaceState,
} from "../state.js";
import type { Override, Policy } from "./schema.js";

/** Reload inside the worktree writer boundary; callers never merge a saved snapshot. */
export async function mutatePolicy(
  root: string,
  update: (current: Policy) => Policy,
): Promise<Result<Policy>> {
  return withCurrentWorkspace(root, async (state) => {
    const updated = update(state.policy);
    const written = await savePolicy(state.paths, updated);
    return written.ok ? ok(updated) : written;
  });
}

/** The synchronous callback allocates ids and preserves revocations from the current revision. */
export async function mutateOverrides<T>(
  root: string,
  update: (
    current: readonly Override[],
  ) => Result<{ readonly overrides: readonly Override[]; readonly value: T }>,
): Promise<Result<T>> {
  return withCurrentWorkspace(root, async (state) => {
    const updated = update(state.overrides);
    if (!updated.ok) return updated;
    const written = await saveOverrides(state.paths, updated.value.overrides);
    return written.ok ? ok(updated.value.value) : written;
  });
}

async function withCurrentWorkspace<T>(
  root: string,
  mutation: (state: WorkspaceState) => Promise<Result<T>>,
): Promise<Result<T>> {
  // Taking a lock creates its state directory; establish initialization before doing so.
  const initial = await loadWorkspaceForMutation(root);
  if (!initial.ok) return initial;
  return withStateMutation(root, async () => {
    const current = await loadWorkspace(root);
    return current.ok ? mutation(current.value) : current;
  });
}
