import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { Status } from "../artifacts/project.js";
import type { WorkspaceState } from "../state.js";

/** Explicit IDs never fall back to feature-wide evidence. Active IDs belong to their feature. */
export function resolveTaskSelection<T extends { readonly id: string }>(
  tasks: readonly T[],
  feature: string,
  explicit: string | undefined,
  status: Status | undefined,
): Result<T | undefined> {
  const id = explicit ?? (status?.activeFeature === feature ? status.activeTask : undefined);
  if (id === undefined) return ok(undefined);
  const task = tasks.find((candidate) => candidate.id === id);
  return task
    ? ok(task)
    : err(vispError("TASK_NOT_FOUND", `Task ${id} does not exist in ${feature}`));
}

export async function resolveLegacyTask(state: WorkspaceState, feature: string, explicit?: string) {
  const graph = await state.store.readTasksIfExists(feature);
  if (!graph.ok) return graph;
  return resolveTaskSelection(graph.value?.tasks ?? [], feature, explicit, state.status);
}
