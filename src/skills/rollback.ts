import { vispError } from "../core/errors.js";
import { withStateMutation } from "../core/file-transaction.js";
import { err, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import { activateSkill, findSkill, validateSkillForAdmission } from "./lifecycle.js";
import type { SkillRecord } from "./schema.js";
import { readSkillHistory } from "./store.js";
import { readSkillRevision } from "./versions.js";

/** Restores only a previously admitted revision, with current support and fresh human review. */
export async function rollbackSkill(
  state: WorkspaceState,
  id: string,
  version: string,
  input: { by: string; reason: string },
): Promise<Result<SkillRecord>> {
  if (!input.by.trim() || !input.reason.trim())
    return err(vispError("UNSUPPORTED", "Rollback requires a reviewer and reason"));
  return withStateMutation(state.paths.root, async () => {
    const current = await findSkill(state, id);
    if (!current.ok) return current;
    const revision = await readSkillRevision(state, id, version);
    if (!revision.ok) return revision;
    if (!revision.value)
      return err(vispError("ARTIFACT_MISSING", `No immutable revision ${id}@${version}`));
    const history = await readSkillHistory(state, id);
    if (!history.ok) return history;
    const admissions = history.value.filter(
      (event) => event.record.version === version && event.record.state === "admitted",
    );
    const admitted = admissions.at(-1)?.record;
    if (!admitted)
      return err(
        vispError("UNSUPPORTED", "Rollback cannot activate a revision that was never admitted"),
      );
    const harmful = history.value.some(
      (event) =>
        event.record.version === version && event.record.evidence?.usefulness === "harmful",
    );
    if (harmful)
      return err(
        vispError(
          "UNSUPPORTED",
          "A revision with harmful reviewed evidence must be revised and evaluated again",
        ),
      );
    const checked = await validateSkillForAdmission(state, admitted, revision.value.content);
    if (!checked.ok) return checked;
    return activateSkill(state, checked.value, revision.value.content, input);
  });
}
