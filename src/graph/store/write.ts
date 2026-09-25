import type { DatabaseSync } from "node:sqlite";
import type { GraphSnapshot } from "../types.js";
import { INSERTS, SNAPSHOT_TABLES } from "./schema.js";

/**
 * Row writing for one snapshot. Called inside an open transaction; any throw
 * here aborts the whole publish, which is why nothing is validated away.
 */
export function writeSnapshotRows(db: DatabaseSync, snapshot: GraphSnapshot): void {
  for (const table of SNAPSHOT_TABLES) {
    db.prepare(`DELETE FROM ${table} WHERE snapshot_id = ?`).run(snapshot.id);
  }
  db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshot.id);

  db.prepare(INSERTS.snapshot).run(
    snapshot.id,
    snapshot.root,
    snapshot.createdAt,
    snapshot.fingerprint,
    snapshot.extractionFingerprint ?? null,
    snapshot.schemaVersion,
    JSON.stringify(snapshot.languageCoverage),
  );

  const file = db.prepare(INSERTS.file);
  for (const entry of snapshot.files) {
    file.run(snapshot.id, entry.path, entry.bytes, entry.hash, entry.language);
  }

  const entity = db.prepare(INSERTS.entity);
  for (const entry of snapshot.entities) {
    entity.run(
      snapshot.id,
      entry.id,
      entry.path,
      entry.kind,
      entry.name,
      entry.startLine,
      entry.endLine,
    );
  }

  const relation = db.prepare(INSERTS.relation);
  snapshot.relations.forEach((entry, index) => {
    relation.run(
      snapshot.id,
      index,
      entry.source,
      entry.target,
      entry.kind,
      entry.path,
      entry.line,
    );
  });

  const unknown = db.prepare(INSERTS.unknown);
  snapshot.unknowns.forEach((entry, index) => {
    unknown.run(snapshot.id, index, entry.kind, entry.path, entry.detail);
  });

  const entrypoint = db.prepare(INSERTS.entrypoint);
  snapshot.entrypoints.forEach((entry, index) => {
    entrypoint.run(
      snapshot.id,
      index,
      entry.kind,
      entry.path,
      entry.name,
      entry.line,
      entry.evidence,
    );
  });
}
