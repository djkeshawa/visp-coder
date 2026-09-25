import { PRODUCT_STATE_VERSION } from "../../core/constants.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import type { WorkspaceState } from "../state.js";
import { briefPath, json, type ProductRecord, productStatePath } from "./store.js";

/** Compose the generation boundary with finding and budget upgrades in one backed-up write. */
export function planStateVersionMigration(
  workspace: WorkspaceState,
  record: ProductRecord,
  prior: FileMutation[],
): FileMutation[] {
  const original = JSON.parse(record.stateText);
  if (original.version !== 2) return prior;
  const path = productStatePath(workspace, record.brief.feature);
  const existing = prior.find((mutation) => mutation.path === path);
  const planned =
    existing?.kind === "write"
      ? JSON.parse(
          typeof existing.content === "string"
            ? existing.content
            : Buffer.from(existing.content).toString("utf8"),
        )
      : original;
  const mutations: FileMutation[] = [
    ...prior.filter((mutation) => mutation.path !== path),
    {
      kind: "write",
      path,
      content: json({ ...planned, version: PRODUCT_STATE_VERSION }),
      expectedBefore: filePrecondition(record.stateText),
    },
  ];
  const contract = briefPath(workspace, record.brief.feature);
  if (!mutations.some((mutation) => mutation.path === contract))
    mutations.push({
      kind: "write",
      path: contract,
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    });
  return mutations;
}
