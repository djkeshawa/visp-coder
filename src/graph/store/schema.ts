/**
 * STRICT tables throughout: a wrong-typed value fails the write instead of
 * being coerced into a fact nobody wrote.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY,
     root TEXT NOT NULL,
     created_at TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     extraction_fingerprint TEXT,
     schema_version INTEGER NOT NULL,
     language_coverage TEXT NOT NULL
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS files (
     snapshot_id TEXT NOT NULL,
     path TEXT NOT NULL,
     bytes INTEGER NOT NULL,
     hash TEXT NOT NULL,
     language TEXT NOT NULL,
     PRIMARY KEY (snapshot_id, path)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS entities (
     snapshot_id TEXT NOT NULL,
     id TEXT NOT NULL,
     path TEXT NOT NULL,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     PRIMARY KEY (snapshot_id, id)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS relations (
     snapshot_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     source TEXT NOT NULL,
     target TEXT NOT NULL,
     kind TEXT NOT NULL,
     path TEXT NOT NULL,
     line INTEGER NOT NULL,
     PRIMARY KEY (snapshot_id, seq)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS unknowns (
     snapshot_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     path TEXT NOT NULL,
     detail TEXT NOT NULL,
     PRIMARY KEY (snapshot_id, seq)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS entrypoints (
     snapshot_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     kind TEXT NOT NULL,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     line INTEGER NOT NULL,
     evidence TEXT NOT NULL,
     PRIMARY KEY (snapshot_id, seq)
   ) STRICT`,
  `CREATE TABLE IF NOT EXISTS head (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     snapshot_id TEXT NOT NULL,
     updated_at TEXT NOT NULL
   ) STRICT`,
  "CREATE INDEX IF NOT EXISTS entities_by_path ON entities (snapshot_id, path)",
  "CREATE INDEX IF NOT EXISTS relations_by_source ON relations (snapshot_id, source)",
  "CREATE INDEX IF NOT EXISTS relations_by_target ON relations (snapshot_id, target)",
  "CREATE INDEX IF NOT EXISTS relations_by_path ON relations (snapshot_id, path)",
  "CREATE INDEX IF NOT EXISTS unknowns_by_kind ON unknowns (snapshot_id, kind)",
] as const;

export const SNAPSHOT_TABLES = [
  "files",
  "entities",
  "relations",
  "unknowns",
  "entrypoints",
] as const;

export const INSERTS = {
  snapshot: `INSERT INTO snapshots
     (id, root, created_at, fingerprint, extraction_fingerprint, schema_version, language_coverage)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  file: "INSERT INTO files (snapshot_id, path, bytes, hash, language) VALUES (?, ?, ?, ?, ?)",
  entity: `INSERT INTO entities
     (snapshot_id, id, path, kind, name, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  relation: `INSERT INTO relations
     (snapshot_id, seq, source, target, kind, path, line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  unknown: "INSERT INTO unknowns (snapshot_id, seq, kind, path, detail) VALUES (?, ?, ?, ?, ?)",
  entrypoint: `INSERT INTO entrypoints
     (snapshot_id, seq, kind, path, name, line, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  head: `INSERT INTO head (id, snapshot_id, updated_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
     updated_at = excluded.updated_at`,
} as const;
