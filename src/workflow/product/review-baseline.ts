import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { ProductSlice } from "./model.js";
import { authorizationPath, type ProductRecord, reviewBaselinePath } from "./store.js";

/** Retain read-only context and revoke the grant together in the slice's closure transaction. */
export async function reviewBaselineMutations(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice,
): Promise<Result<FileMutation[]>> {
  const active = authorizationPath(workspace, record.brief.feature);
  const auth = await workspace.files.readTextIfExists(active);
  if (!auth.ok) return auth;
  if (!auth.value || JSON.parse(auth.value).task !== slice.id) return ok([]);
  const path = reviewBaselinePath(workspace, record.brief.feature);
  const prior = await workspace.files.readTextIfExists(path);
  if (!prior.ok) return prior;
  return ok([
    {
      kind: "write",
      path,
      content: auth.value,
      mode: 0o600,
      expectedBefore: filePrecondition(prior.value),
    },
    { kind: "remove", path: active, expectedBefore: filePrecondition(auth.value) },
  ]);
}
