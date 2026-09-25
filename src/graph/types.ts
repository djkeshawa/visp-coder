import type { Language } from "../core/constants.js";

/**
 * The vocabulary of the repository intelligence graph. Every fact the graph
 * states — and every gap it admits — has a shape here.
 */

/** A walked file's language, or `other` when no supported grammar applies. */
export type FileLanguage = Language | "other";

export interface FileEntry {
  readonly path: string;
  readonly bytes: number;
  /** sha256 of the file contents. */
  readonly hash: string;
  readonly language: FileLanguage;
}

export const SKIP_REASONS = [
  "too_large",
  "binary",
  "gitignored",
  "excluded",
  "symlink",
  "unreadable",
  "max_files",
  "max_depth",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
}

export interface WalkResult {
  readonly files: FileEntry[];
  readonly skipped: SkippedFile[];
}

export const ENTITY_KINDS = [
  "file",
  "function",
  "class",
  "method",
  "interface",
  "type",
  "variable",
  "module",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface Entity {
  readonly id: string;
  readonly path: string;
  readonly kind: EntityKind;
  readonly name: string;
  /** One-based, inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

export const RELATION_KINDS = [
  "imports",
  "exports",
  "defines",
  "contains",
  "calls",
  "tested_by",
  "external",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export interface Relation {
  readonly source: string;
  /** An entity id, or an `external:` reference for anything outside the repo. */
  readonly target: string;
  readonly kind: RelationKind;
  readonly path: string;
  readonly line: number;
}

export const UNKNOWN_KINDS = [
  "parser_error",
  "parse_timeout",
  "dynamic_import",
  "unresolved_import",
  "unresolved_call",
  "unsupported_language",
  "file_skipped",
] as const;
export type UnknownKind = (typeof UNKNOWN_KINDS)[number];

/** A gap the graph knows about. Never inferred away, never silently dropped. */
export interface UnknownRecord {
  readonly kind: UnknownKind;
  readonly path: string;
  readonly detail: string;
}

export const ENTRYPOINT_KINDS = [
  "http_route",
  "cli_command",
  "package_entrypoint",
  "package_script",
  "test_entrypoint",
  /** A page loading a script: the real entry chain of a browser app. */
  "page_entrypoint",
] as const;
export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number];

/**
 * Entrypoints are only ever recorded from positive evidence in the source. The
 * `evidence` field carries the text that bound it, so a reader can check.
 */
export interface Entrypoint {
  readonly kind: EntrypointKind;
  readonly path: string;
  readonly name: string;
  readonly line: number;
  readonly evidence: string;
}

/** Parsed versus seen, per language, so an empty graph is never mistaken for an empty repo. */
export interface LanguageCoverage {
  readonly language: FileLanguage;
  readonly totalFiles: number;
  readonly parsedFiles: number;
}

export interface ExtractionFacts {
  readonly entities: Entity[];
  readonly relations: Relation[];
  readonly unknowns: UnknownRecord[];
  readonly entrypoints: Entrypoint[];
  readonly languageCoverage: LanguageCoverage[];
}

export interface GraphSnapshot {
  readonly id: string;
  readonly root: string;
  readonly createdAt: string;
  readonly fingerprint: string;
  /** Absent on legacy snapshots, which must be refreshed before reuse. */
  readonly extractionFingerprint?: string;
  readonly schemaVersion: number;
  readonly files: FileEntry[];
  readonly entities: Entity[];
  readonly relations: Relation[];
  readonly unknowns: UnknownRecord[];
  readonly entrypoints: Entrypoint[];
  readonly languageCoverage: LanguageCoverage[];
}

export type SnapshotInput = Omit<GraphSnapshot, "id" | "schemaVersion"> & {
  readonly id?: string;
  readonly schemaVersion?: number;
};
