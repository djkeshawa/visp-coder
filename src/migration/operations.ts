import { vispError } from "../core/errors.js";
import { applyFileTransaction, withStateMutation } from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import { err, ok } from "../core/result.js";
import { withStateLock } from "../core/state-lock.js";
import {
  guardProductMigration,
  type ProductMigrationOutcome,
  planProductMigration,
} from "../workflow/product/migration.js";
import { loadWorkspace } from "../workflow/state.js";
import { planMigrationBackup } from "./backup.js";
import { collectMigrationHistory } from "./history-export.js";

export async function previewMigration(root: string, feature?: string) {
  const workspace = await loadWorkspace(root);
  if (!workspace.ok) return workspace;
  const plan = await planProductMigration(workspace.value, { feature });
  return plan.ok
    ? ok({
        operation: "preview",
        features: plan.value.features,
        changes: plan.value.mutations.map(({ kind, path }) => ({ kind, path })),
      })
    : plan;
}

/** Export uses writer ownership but does not recover or reinterpret old records. */
export async function exportMigrationHistory(root: string, name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name))
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Export name must be a simple identifier of at most 80 characters",
      ),
    );
  return withStateLock(root, async () => {
    const snapshot = await collectMigrationHistory(root);
    if (!snapshot.ok) return snapshot;
    const path = `.visp/exports/${name}.json`;
    const fs = new ProjectFileSystem(root);
    const exists = await fs.exists(path);
    if (!exists.ok) return exists;
    if (exists.value)
      return err(vispError("ARTIFACT_INVALID", "Export already exists; choose a new name"));
    const saved = await fs.writeTextAtomic(
      path,
      `${JSON.stringify(snapshot.value, null, 2)}\n`,
      0o600,
    );
    return saved.ok
      ? ok({
          operation: "export",
          path,
          digest: snapshot.value.digest,
          files: snapshot.value.files.length,
        })
      : saved;
  });
}

interface MigrationApplication {
  operation: "apply";
  changed: number;
  features: ProductMigrationOutcome["features"];
  backup?: string;
}

export async function applyMigration(root: string, feature?: string) {
  return withStateMutation<MigrationApplication>(root, async () => {
    const workspace = await loadWorkspace(root);
    if (!workspace.ok) return workspace;
    const plan = await planProductMigration(workspace.value, { feature });
    if (!plan.ok) return plan;
    if (!plan.value.mutations.length)
      return ok({ operation: "apply", changed: 0, features: plan.value.features });
    const allowed = await guardProductMigration(workspace.value, plan.value.features);
    if (!allowed.ok) return allowed;
    const backup = await planMigrationBackup(root);
    if (!backup.ok) return backup;
    const applied = await applyFileTransaction(root, "standalone-product-migration", [
      backup.value.mutation,
      ...plan.value.mutations,
    ]);
    return applied.ok
      ? ok({
          operation: "apply",
          changed: applied.value.changed,
          features: plan.value.features,
          backup: backup.value.path,
        })
      : applied;
  });
}
