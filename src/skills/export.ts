import { PRODUCT_NAME } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { parseProjectFilePath } from "../core/input.js";
import { err, ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "../workflow/state.js";
import { findSkill } from "./lifecycle.js";
import { fingerprint, readSkillBody } from "./store.js";

export interface ExportOptions {
  readonly file: string;
  readonly force?: boolean;
}

/** Writes an admitted skill that still matches its recorded hash to a project file. */
export async function exportSkill(
  state: WorkspaceState,
  id: string,
  input: ExportOptions,
): Promise<Result<{ readonly id: string; readonly file: string }>> {
  const found = await findSkill(state, id);
  if (!found.ok) return found;
  if (found.value.state !== "admitted") {
    return err(vispError("UNSUPPORTED", `${id} is ${found.value.state}, not admitted`));
  }

  const body = await readSkillBody(state, id);
  if (!body.ok) return body;
  if (body.value === undefined) {
    return err(vispError("ARTIFACT_MISSING", `${id} has no SKILL.md on disk`));
  }
  if (fingerprint(body.value) !== found.value.contentHash) {
    return err(
      vispError("ARTIFACT_INVALID", `${id} was edited since it was admitted`, {
        recovery: `${PRODUCT_NAME} skill diff ${id}`,
      }),
    );
  }

  const parsedDestination = parseProjectFilePath(input.file);
  if (!parsedDestination.ok) return parsedDestination;
  const destination = parsedDestination.value;
  const existing = await state.files.readTextIfExists(destination);
  if (!existing.ok) return existing;
  if (existing.value !== undefined && existing.value !== body.value && !input.force) {
    return err(
      vispError("ARTIFACT_INVALID", `${input.file} already exists with different content`),
    );
  }

  if (existing.value !== body.value) {
    const written = await state.files.writeTextAtomic(destination, body.value);
    if (!written.ok) return written;
  }
  return ok({ id, file: state.paths.absolute(destination) });
}
