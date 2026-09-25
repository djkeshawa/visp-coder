import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { fromUnknown, vispError } from "../../core/errors.js";
import type { ProjectFileSystem } from "../../core/fs.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import { GRAPH_SCHEMA_VERSION } from "../constants.js";
import type { GraphSnapshot, SnapshotInput } from "../types.js";
import {
  parseCoverage,
  text,
  toEntity,
  toEntrypoint,
  toFile,
  toRelation,
  toUnknown,
} from "./rows.js";
import { INSERTS, SCHEMA_STATEMENTS, SNAPSHOT_TABLES } from "./schema.js";
import { writeSnapshotRows } from "./write.js";

/**
 * Loaded at runtime rather than imported: bundlers that do not recognise
 * `node:sqlite` as a builtin rewrite the specifier to a bare `sqlite`, which
 * then fails to resolve.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

/** Opaque identity is local to one connection; equal numbers on another store are unrelated. */
export interface GraphRevision {
  readonly localMutation: number;
  readonly dataVersion: number;
}

/**
 * One SQLite file per repository. A publish is a single immediate transaction
 * whose last statement moves the head, so a reader sees the previous complete
 * snapshot or the new complete snapshot and never a half-written one.
 */
export class GraphStore {
  private localMutation = 0;
  private revision: GraphRevision | undefined;

  private constructor(private readonly db: DatabaseSyncType) {}

  static open(path: string): Result<GraphStore> {
    try {
      if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
    return GraphStore.connect(path);
  }

  /** Opens a project-owned database only after its path and parent are confined. */
  static async openProject(
    files: ProjectFileSystem,
    path: string,
    options: { readonly writable?: boolean } = {},
  ): Promise<Result<GraphStore>> {
    if (path === ":memory:") {
      return err(vispError("IO_ERROR", "A project graph store requires a project path"));
    }
    const writable = options.writable === true;
    const prepared = await prepareGraphDirectory(files, path, writable);
    if (!prepared.ok) return prepared;

    // Revalidate immediately before SQLite can create or mutate the database
    // and its WAL siblings. The remaining local attacker race is the same
    // path-based filesystem limitation documented by ProjectFileSystem.
    const targets = await validateGraphTargets(files, path, writable);
    if (!targets.ok) return targets;
    return GraphStore.connect(path, writable);
  }

  close(): void {
    this.invalidateRevision();
    try {
      this.db.close();
    } catch {
      // Already closed; nothing to release.
    }
  }

  /** SQLite data_version changes for commits by other connections, including same-ID writes. */
  readRevision(): Result<GraphRevision> {
    try {
      const row = this.db.prepare("PRAGMA data_version").get();
      const dataVersion = Number(row?.data_version);
      if (!Number.isSafeInteger(dataVersion)) {
        return err(vispError("IO_ERROR", "SQLite did not return a usable graph data version"));
      }
      if (!this.revision || this.revision.dataVersion !== dataVersion) {
        this.revision = Object.freeze({ localMutation: this.localMutation, dataVersion });
      }
      return ok(this.revision);
    } catch (cause) {
      this.revision = undefined;
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  publishSnapshot(input: SnapshotInput): Result<GraphSnapshot> {
    const snapshot: GraphSnapshot = {
      ...input,
      id: input.id ?? snapshotId(input),
      schemaVersion: input.schemaVersion ?? GRAPH_SCHEMA_VERSION,
    };

    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }

    try {
      writeSnapshotRows(this.db, snapshot);
      // Last statement in the transaction: nothing points at a partial snapshot.
      this.db.prepare(INSERTS.head).run(snapshot.id, snapshot.createdAt);
      this.db.exec("COMMIT");
      this.invalidateRevision();
    } catch (cause) {
      this.rollback();
      return err(fromUnknown(cause, "IO_ERROR"));
    }

    this.pruneTo(snapshot.id);
    return ok(snapshot);
  }

  readHead(): Result<GraphSnapshot | undefined> {
    return this.readTransaction(() => {
      const id = this.readHeadId();
      if (!id.ok) return id;
      return ok(id.value ? this.readSnapshotRows(id.value) : undefined);
    });
  }

  /** Reads only the pointer, avoiding a full graph load for freshness checks. */
  readHeadId(): Result<string | undefined> {
    try {
      const row = this.db.prepare("SELECT snapshot_id FROM head WHERE id = 1").get();
      if (!row) return ok(undefined);
      return ok(text(row, "snapshot_id"));
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  requireHead(): Result<GraphSnapshot> {
    const head = this.readHead();
    if (!head.ok) return head;
    if (!head.value) {
      return err(
        vispError("GRAPH_MISSING", "No graph snapshot has been published", {
          recovery: "visp graph index",
        }),
      );
    }
    return ok(head.value);
  }

  readSnapshot(id: string): Result<GraphSnapshot | undefined> {
    return this.readTransaction(() => ok(this.readSnapshotRows(id)));
  }

  private readSnapshotRows(id: string): GraphSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id);
    if (!row) return undefined;

    return {
      id: text(row, "id"),
      root: text(row, "root"),
      createdAt: text(row, "created_at"),
      fingerprint: text(row, "fingerprint"),
      ...(typeof row.extraction_fingerprint === "string"
        ? { extractionFingerprint: row.extraction_fingerprint }
        : {}),
      schemaVersion: Number(row.schema_version),
      languageCoverage: parseCoverage(text(row, "language_coverage")),
      files: this.select("files", id, "path").map(toFile),
      entities: this.select("entities", id, "path, start_line, id").map(toEntity),
      relations: this.select("relations", id, "seq").map(toRelation),
      unknowns: this.select("unknowns", id, "seq").map(toUnknown),
      entrypoints: this.select("entrypoints", id, "seq").map(toEntrypoint),
    };
  }

  /** Content hashes of the published snapshot, for deciding what to re-parse. */
  readFileHashes(): Result<Map<string, string>> {
    const head = this.readHead();
    if (!head.ok) return head;
    const hashes = new Map<string, string>();
    for (const file of head.value?.files ?? []) hashes.set(file.path, file.hash);
    return ok(hashes);
  }

  deleteRepository(): Result<void> {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("DELETE FROM head");
      for (const table of SNAPSHOT_TABLES) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec("DELETE FROM snapshots");
      this.db.exec("COMMIT");
      this.invalidateRevision();
      return ok(undefined);
    } catch (cause) {
      this.rollback();
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  private invalidateRevision(): void {
    this.localMutation += 1;
    this.revision = undefined;
  }

  /** The head pointer, metadata, and every row table must share one SQLite read snapshot. */
  private readTransaction<T>(read: () => Result<T>): Result<T> {
    try {
      this.db.exec("BEGIN");
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
    try {
      const result = read();
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.rollback();
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  private select(table: string, snapshotId: string, order: string) {
    return this.db
      .prepare(`SELECT * FROM ${table} WHERE snapshot_id = ? ORDER BY ${order}`)
      .all(snapshotId);
  }

  /** Old snapshots are dead weight once the head has moved past them. */
  private pruneTo(keep: string): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      for (const table of SNAPSHOT_TABLES) {
        this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id != ?`).run(keep);
      }
      this.db.prepare("DELETE FROM snapshots WHERE id != ?").run(keep);
      this.db.exec("COMMIT");
    } catch {
      this.rollback();
      return;
    }

    try {
      // Deleted rows only ever moved to the freelist — real stores measured
      // ~half free pages, 6–10× the source they described. Cannot run inside
      // the transaction; failing to compact is not failing to publish.
      this.db.exec("VACUUM");
    } catch {
      // The snapshot is already durable; a skipped compaction costs disk only.
    }
  }

  private rollback(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // No transaction was open.
    }
  }

  private static connect(path: string, writable = true): Result<GraphStore> {
    try {
      const db = writable ? new DatabaseSync(path) : new DatabaseSync(path, { readOnly: true });
      if (writable) db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      if (writable) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
          const columns = db.prepare("PRAGMA table_info(snapshots)").all();
          if (!columns.some((column) => column.name === "extraction_fingerprint")) {
            db.exec("ALTER TABLE snapshots ADD COLUMN extraction_fingerprint TEXT");
          }
          db.exec("COMMIT");
        } catch (cause) {
          db.exec("ROLLBACK");
          db.close();
          throw cause;
        }
      }
      return ok(new GraphStore(db));
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }
}

async function prepareGraphDirectory(
  files: ProjectFileSystem,
  path: string,
  writable: boolean,
): Promise<Result<void>> {
  if (writable) return files.ensureDir(dirname(path));
  const parent = await files.metadata(dirname(path));
  if (!parent.ok) return parent;
  return parent.value?.type === "directory"
    ? ok(undefined)
    : err(vispError("ARTIFACT_MISSING", `Graph store directory is missing: ${path}`));
}

async function validateGraphTargets(
  files: ProjectFileSystem,
  path: string,
  writable: boolean,
): Promise<Result<void>> {
  for (const candidate of [`${path}-wal`, `${path}-shm`, `${path}-journal`, path]) {
    const target = await files.metadata(candidate);
    if (!target.ok) return target;
    if (target.value && target.value.type !== "file") {
      return err(vispError("IO_ERROR", `Graph store path is not a regular file: ${candidate}`));
    }
    if (candidate === path && !target.value && !writable) {
      return err(vispError("ARTIFACT_MISSING", `Graph store is missing: ${path}`));
    }
  }
  return ok(undefined);
}

/** Compatibility opener for in-memory/trusted callers; project code uses openProjectStore. */
export function openStore(path: string): Result<GraphStore> {
  return GraphStore.open(path);
}

export function openProjectStore(
  files: ProjectFileSystem,
  path: string,
  options: { readonly writable?: boolean } = {},
): Promise<Result<GraphStore>> {
  return GraphStore.openProject(files, path, options);
}

function snapshotId(input: SnapshotInput): string {
  return hashValue({
    root: input.root,
    fingerprint: input.fingerprint,
    extractionFingerprint: input.extractionFingerprint,
    createdAt: input.createdAt,
  }).slice(0, 24);
}
