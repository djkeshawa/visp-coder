import { hashValue, sha256 } from "../../../core/hash.js";
import { ok, type Result } from "../../../core/result.js";
import type { ContextPack } from "../../artifacts/context.js";
import type { WorkspaceState } from "../../state.js";

/** Stable identity of the selected context files as they exist in the worktree now. */
export async function currentContextSourceHash(
  state: WorkspaceState,
  pack: ContextPack,
): Promise<Result<string>> {
  const sources: Array<{ path: string; digest: string | null }> = [];
  for (const file of pack.files) {
    const bytes = await state.files.readBytesIfExists(state.paths.absolute(file.path));
    if (!bytes.ok) return bytes;
    sources.push({
      path: file.path,
      digest: bytes.value === undefined ? null : sha256(bytes.value),
    });
  }
  return ok(hashValue(sources));
}
