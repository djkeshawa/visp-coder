import { vispError } from "../core/errors.js";
import { type FileMutation, filePrecondition } from "../core/file-transaction.js";
import { ProjectFileSystem } from "../core/fs.js";
import { err, ok, type Result } from "../core/result.js";
import { collectMigrationHistory } from "./history-export.js";

/** Plan the backup under writer ownership; application commits it with the upgrade. */
export async function planMigrationBackup(
  root: string,
): Promise<Result<{ path: string; mutation: FileMutation }>> {
  const snapshot = await collectMigrationHistory(root);
  if (!snapshot.ok) return snapshot;
  const path = `.visp/migrations/backups/${snapshot.value.digest}.json`;
  const content = `${JSON.stringify(snapshot.value, null, 2)}\n`;
  const existing = await new ProjectFileSystem(root).readTextIfExists(path);
  if (!existing.ok) return existing;
  if (existing.value !== undefined && existing.value !== content)
    return err(
      vispError("ARTIFACT_INVALID", "Existing migration backup differs; refusing to replace it"),
    );
  const mutation: FileMutation = {
    kind: "write",
    path,
    content,
    mode: 0o600,
    expectedBefore: filePrecondition(existing.value),
  };
  return ok({ path, mutation });
}
