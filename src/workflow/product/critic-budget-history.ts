import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { type CriticState, criticStateSchema } from "./critic-model.js";

/** Keep the exact input bytes as a transaction precondition; parsed values alone lose races. */
export async function readCriticBudgetHistory(
  workspace: WorkspaceState,
  path: string,
): Promise<Result<{ state: CriticState; guard: FileMutation }>> {
  const content = await workspace.files.readText(path);
  if (!content.ok) return content;
  const metadata = await workspace.files.metadata(path);
  if (!metadata.ok) return metadata;
  try {
    const state = criticStateSchema.parse(JSON.parse(content.value));
    const guard: FileMutation = {
      kind: "write",
      path,
      content: content.value,
      mode: metadata.value?.mode,
      expectedBefore: filePrecondition(content.value, metadata.value?.mode),
    };
    return ok({ state, guard });
  } catch {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Invalid critic history; feature spending cannot be established",
      ),
    );
  }
}
