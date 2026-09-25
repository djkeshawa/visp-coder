import type { SQLOutputValue } from "node:sqlite";
import type {
  Entity,
  EntityKind,
  Entrypoint,
  EntrypointKind,
  FileEntry,
  FileLanguage,
  LanguageCoverage,
  Relation,
  RelationKind,
  UnknownKind,
  UnknownRecord,
} from "../types.js";

type Row = Record<string, SQLOutputValue>;

/** Reading is total: a row that cannot be interpreted is a store defect, not a silent gap. */

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new TypeError(`Column ${column} is not text`);
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`Column ${column} is not an integer`);
}

export function toFile(row: Row): FileEntry {
  return {
    path: text(row, "path"),
    bytes: integer(row, "bytes"),
    hash: text(row, "hash"),
    language: text(row, "language") as FileLanguage,
  };
}

export function toEntity(row: Row): Entity {
  return {
    id: text(row, "id"),
    path: text(row, "path"),
    kind: text(row, "kind") as EntityKind,
    name: text(row, "name"),
    startLine: integer(row, "start_line"),
    endLine: integer(row, "end_line"),
  };
}

export function toRelation(row: Row): Relation {
  return {
    source: text(row, "source"),
    target: text(row, "target"),
    kind: text(row, "kind") as RelationKind,
    path: text(row, "path"),
    line: integer(row, "line"),
  };
}

export function toUnknown(row: Row): UnknownRecord {
  return {
    kind: text(row, "kind") as UnknownKind,
    path: text(row, "path"),
    detail: text(row, "detail"),
  };
}

export function toEntrypoint(row: Row): Entrypoint {
  return {
    kind: text(row, "kind") as EntrypointKind,
    path: text(row, "path"),
    name: text(row, "name"),
    line: integer(row, "line"),
    evidence: text(row, "evidence"),
  };
}

export function parseCoverage(serialized: string): LanguageCoverage[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is LanguageCoverage => isCoverage(entry));
}

function isCoverage(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.language === "string" && typeof record.totalFiles === "number";
}
