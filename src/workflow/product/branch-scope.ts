import { vispError } from "../../core/errors.js";
import { changesSince, currentBranch } from "../../core/git.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";

/** CI identifies every feature carried by the PR, even after a branch rename. */
export async function branchFeatures(
  workspace: WorkspaceState,
  options: { base?: string; branch?: string; feature?: string },
): Promise<Result<string[]>> {
  if (options.feature) return ok([options.feature]);
  const listed = await workspace.store.listFeatures();
  if (!listed.ok) return listed;
  const changed = new Set<string>();
  if (options.base) {
    const diff = await changesSince(workspace.paths.root, options.base);
    if (!diff.ok) return diff;
    for (const file of diff.value.files) {
      const feature = /^\.visp\/features\/([^/]+)\//.exec(file.path)?.[1];
      if (feature) changed.add(feature);
    }
  }
  const branch = options.branch ? ok(options.branch) : await currentBranch(workspace.paths.root);
  if (!branch.ok) return branch;
  const selected: string[] = [];
  for (const feature of listed.value) {
    const intent = await workspace.store.readIntent(feature);
    if (
      changed.has(feature) ||
      (branch.value !== "HEAD" && intent.ok && intent.value.branch === branch.value)
    )
      selected.push(feature);
  }
  return selected.length
    ? ok(selected)
    : err(
        vispError(
          "NO_ACTIVE_FEATURE",
          "No feature matches this branch or the pull request's changed feature trail",
          {
            recovery:
              "Commit the feature brief with the change, or select it with visp guard --scope tasks --feature <id> --base <ref>",
          },
        ),
      );
}
