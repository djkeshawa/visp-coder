import { workingTreeChanges } from "../../core/git.js";
import { matchesAny } from "../../core/patterns.js";
import type { WorkspaceState } from "../state.js";
import { byproductProtection, skippedByproduct } from "./byproducts.js";
import { unchangedInheritedPaths } from "./inherited-changes.js";
import type { ProductBrief } from "./model.js";
import { declaredSourcePatterns } from "./source-inputs.js";

export async function productInputWarnings(
  workspace: WorkspaceState,
  brief: ProductBrief,
): Promise<string[]> {
  const changes = await workingTreeChanges(workspace.paths.root);
  if (!changes.ok) return [`Could not inspect untracked product inputs: ${changes.error.message}`];
  const patterns = declaredSourcePatterns(brief);
  const protection = byproductProtection(workspace, brief);
  const inherited = await unchangedInheritedPaths(workspace, brief.feature);
  const outside = changes.value.files.filter(
    (file) =>
      file.status === "untracked" &&
      !inherited.has(file.path) &&
      !file.path.startsWith(".visp/") &&
      !matchesAny(file.path, patterns) &&
      // Untracked tool output (caches, logs) is not part of the evidence, so it is not a warning.
      !skippedByproduct(file.path, false, protection),
  );
  const first = outside[0];
  return first
    ? [
        `Untracked file ${first.path}${outside.length > 1 ? ` (and ${outside.length - 1} more)` : ""} is outside every slice scope and check input. It still affects evidence freshness. Add ignore rules for generated output, or declare intended product files before checking.`,
      ]
    : [];
}
