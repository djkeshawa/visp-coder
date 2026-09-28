import { matchesAny } from "../../core/patterns.js";
import type { WorkspaceState } from "../state.js";
import { checksFor, type ProductBrief, type ProductSlice } from "./model.js";

export function declaredSourcePatterns(brief?: ProductBrief, slice?: ProductSlice): string[] {
  if (!brief) return [];
  const checks = slice ? checksFor(brief, slice) : brief.checks;
  return [
    ...(slice ? [slice] : brief.slices).flatMap((entry) => [
      ...entry.scope.allowed,
      ...entry.scope.expected,
    ]),
    ...checks.flatMap((check) => [...check.files, ...(check.verifierFiles ?? [])]),
    ...brief.acceptanceBaseline.flatMap((check) => check.files.map((file) => file.path)),
  ];
}

export function sourceInputPatterns(
  workspace: WorkspaceState,
  brief?: ProductBrief,
  slice?: ProductSlice,
): string[] {
  return [
    ...declaredSourcePatterns(brief, slice),
    ...[workspace.paths.config, workspace.paths.policy, workspace.paths.overrides].flatMap(
      (path) => {
        const relative = workspace.paths.relative(path);
        return relative === undefined ? [] : [relative];
      },
    ),
    "package.json",
    ".gitignore",
  ];
}

export function candidateSourcePaths(
  workspace: WorkspaceState,
  brief: ProductBrief,
  snapshot: Record<string, string>,
  slice?: ProductSlice,
) {
  const patterns = sourceInputPatterns(workspace, brief, slice);
  return Object.keys(snapshot).filter((path) => matchesAny(path, patterns));
}
