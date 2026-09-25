import { withStateMutation } from "../../core/file-transaction.js";
import type { Result } from "../../core/result.js";
import { requireInstalledRuntime } from "../../harness/runtime.js";
import type { WorkspaceState } from "../state.js";

/** Check under writer ownership, before authorizing execution or publishing product state. */
export function withProductMutation<T>(
  workspace: WorkspaceState,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  return withStateMutation(workspace.paths.root, async () => {
    const agreed = await requireInstalledRuntime(workspace.paths, workspace.files);
    return agreed.ok ? operation() : agreed;
  });
}
