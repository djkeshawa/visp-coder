import { ok, type Result } from "../../core/result.js";
import type { SkillCandidate } from "../../skills/rank.js";
import { fingerprint, readSkillBody, skillPath } from "../../skills/store.js";
import type { WorkspaceState } from "../state.js";
import type { ProductSkills } from "./skills.js";

/** Read admitted bodies and fit their excerpts within the existing delivery limits. */
export async function packProductSkills(
  workspace: WorkspaceState,
  ranked: readonly SkillCandidate[],
  remaining: number,
  limit: number,
  selectionNotes: readonly string[],
): Promise<Result<ProductSkills>> {
  const skills: ProductSkills["skills"] = [];
  const notes = [...selectionNotes];
  let visited = 0;
  for (const candidate of ranked) {
    if (skills.length >= limit || remaining <= 0) break;
    visited++;
    const content = await readSkillBody(workspace, candidate.skill.id);
    if (!content.ok) return content;
    if (content.value === undefined || fingerprint(content.value) !== candidate.skill.contentHash) {
      notes.push(
        `${candidate.skill.id}: its file is not the one that was admitted; skill omitted. Inspect visp skill diff ${candidate.skill.id}`,
      );
      continue;
    }
    const path = workspace.paths.relative(skillPath(workspace, candidate.skill.id));
    if (!path) continue;
    const excerpt = content.value.slice(0, Math.min(remaining, 2_000));
    remaining -= excerpt.length;
    if (excerpt.length < content.value.length)
      notes.push(
        `${candidate.skill.id}: content truncated to ${excerpt.length} of ${content.value.length} characters; read ${path} for the full admitted skill.`,
      );
    skills.push({
      path,
      content: excerpt,
      truncated: excerpt.length < content.value.length,
      reason: "skill",
      advisory: true,
    });
  }
  if (visited < ranked.length)
    notes.push(
      `${ranked.length - visited} matching skill omitted by the context budget or skill limit.`,
    );
  if (skills.length)
    notes.push(
      "Selected skills are advisory craft knowledge, not evidence or authority to change scope",
    );
  return ok({ skills, notes });
}
