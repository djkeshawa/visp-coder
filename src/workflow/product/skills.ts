import { ok, type Result } from "../../core/result.js";
import type { ApplicationFacts } from "../../skills/applies.js";
import { readCurrentLineage } from "../../skills/lineage.js";
import { rankSkills } from "../../skills/rank.js";
import type { WorkspaceState } from "../state.js";
import type { ProductSlice } from "./model.js";
import { packProductSkills } from "./skill-context.js";
import { skillGraphFacts } from "./skill-graph-facts.js";
import { skillSelectionNotes } from "./skill-selection-notes.js";

export interface ProductSkills {
  readonly skills: {
    path: string;
    content: string;
    truncated: boolean;
    reason: "skill";
    advisory: true;
  }[];
  readonly notes: string[];
}
/** Reuses admission, trigger and lineage checks without reviving artifact drafting stages. */
export async function productSkills(
  workspace: WorkspaceState,
  slice: ProductSlice,
  remaining = 6_000,
): Promise<Result<ProductSkills>> {
  const notes: string[] = [];
  const limit = Math.min(3, workspace.config.skills.maxPerPack);
  if (!workspace.config.skills.enabled || limit <= 0 || remaining <= 0)
    return ok({
      skills: [],
      notes: [
        !workspace.config.skills.enabled
          ? "Skill selection is disabled in configuration."
          : limit <= 0
            ? "The configured skill limit is zero."
            : "No context budget remains for skills.",
      ],
    });
  const lineage = await readCurrentLineage(workspace);
  if (!lineage.ok) return lineage;
  const graph = await skillGraphFacts(workspace, slice, lineage.value);
  notes.push(...graph.notes);
  const facts: ApplicationFacts = {
    ...graph.facts,
    taskClass: slice.taskClass,
    stages: ["context", "implement"],
    scopePaths: [...slice.scope.allowed, ...slice.scope.expected],
  };
  const ranked = rankSkills({ skills: lineage.value, facts });
  notes.push(...skillSelectionNotes(lineage.value, ranked, facts));
  return packProductSkills(workspace, ranked, remaining, limit, notes);
}
