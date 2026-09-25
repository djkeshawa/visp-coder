import { withStateMutation } from "../core/file-transaction.js";
import { ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { SkillRecord } from "./schema.js";
import { readIndex, upsert } from "./store.js";
import { currentSupport } from "./support.js";

export { currentSupport, type Support, supportFor } from "./support.js";

/**
 * A skill cannot outlive the evidence that justified it.
 *
 * Deleting the work a skill was drawn from does not delete the skill: the
 * derived artifact keeps working long after its source is gone, which is how a
 * bad lesson survives the cleanup that was supposed to remove it. So the link
 * runs the other way too — when a source task stops being closed work, the
 * skill drawn from it stops being usable until someone looks again.
 */

/**
 * Suspends admitted skills whose support changed. Restoring support does not
 * silently reactivate a skill; a person must review and admit it again.
 */
export async function reconcileLineage(state: WorkspaceState): Promise<Result<SkillRecord[]>> {
  return withStateMutation(state.paths.root, () => reconcileLocked(state));
}

async function reconcileLocked(state: WorkspaceState): Promise<Result<SkillRecord[]>> {
  const index = await readIndex(state);
  if (!index.ok) return index;

  const projected = await projectLineage(state, index.value.skills);
  const changed: SkillRecord[] = [];
  for (let position = 0; position < projected.length; position += 1) {
    const before = index.value.skills[position];
    const after = projected[position];
    if (before !== after && after) changed.push(after);
  }

  if (changed.length === 0) return ok([]);

  for (const skill of changed) {
    const written = await upsert(state, skill);
    if (!written.ok) return written;
  }
  return ok(changed);
}

/** Current lineage projected from task state without changing the skill index. */
export async function readCurrentLineage(state: WorkspaceState): Promise<Result<SkillRecord[]>> {
  const index = await readIndex(state);
  if (!index.ok) return index;
  return ok(await projectLineage(state, index.value.skills));
}

async function projectLineage(
  state: WorkspaceState,
  skills: readonly SkillRecord[],
): Promise<SkillRecord[]> {
  const projected: SkillRecord[] = [];
  for (const skill of skills) projected.push((await reconcileOne(state, skill)) ?? skill);
  return projected;
}

/** The skill as it should now stand, or undefined when nothing about it moved. */
async function reconcileOne(
  state: WorkspaceState,
  skill: SkillRecord,
): Promise<SkillRecord | undefined> {
  if (skill.state !== "admitted") return undefined;

  // Seeded knowledge was never drawn from local work, so there is no local work
  // whose removal could invalidate it. Orphaning it would be reporting a loss of
  // support it never claimed to have.
  if (skill.origin === "seeded") return undefined;

  const support = await currentSupport(state, skill);
  const required = Math.max(skill.minSupport ?? 1, state.config.skills.minSupport);
  const orphaned = support.closed.length < required || support.lost.length > 0;

  if (orphaned && skill.state === "admitted") {
    return {
      ...skill,
      state: "orphaned",
      reason:
        `Learning support changed: ${support.closed.length}/${required} closed tasks remain; ` +
        `lost or changed: ${support.lost.join(", ") || "insufficient support"}. Review before readmission.`,
    };
  }

  return undefined;
}
