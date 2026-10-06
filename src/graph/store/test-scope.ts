import type { DatabaseSync } from "node:sqlite";
import { text, toFile } from "./rows.js";

/** Indexed, snapshot-consistent facts for advice; no full graph materialization. */
export function readTestScope(db: DatabaseSync, snapshotId: string, paths: readonly string[]) {
  const snapshot = db
    .prepare(
      "SELECT s.root FROM snapshots s JOIN head h ON h.snapshot_id = s.id WHERE h.id = 1 AND s.id = ?",
    )
    .get(snapshotId);
  if (!snapshot) return undefined;
  const file = db.prepare("SELECT * FROM files WHERE snapshot_id = ? AND path = ?");
  const related = db.prepare(`
    SELECT r.path FROM entities e
    JOIN relations r ON r.snapshot_id = e.snapshot_id AND r.target = e.id
    WHERE e.snapshot_id = ? AND e.path = ? AND r.kind = 'imports'
    UNION
    SELECT t.path FROM entities e
    JOIN relations r ON r.snapshot_id = e.snapshot_id AND r.source = e.id
    JOIN entities t ON t.snapshot_id = r.snapshot_id AND t.id = r.target
    WHERE e.snapshot_id = ? AND e.path = ? AND e.kind = 'file' AND r.kind = 'tested_by'
  `);
  const files = [];
  const tests = new Set<string>();
  for (const path of paths) {
    const row = file.get(snapshotId, path);
    if (row) files.push(toFile(row));
    for (const entry of related.all(snapshotId, path, snapshotId, path))
      tests.add(text(entry, "path"));
  }
  return { root: text(snapshot, "root"), files, tests };
}
