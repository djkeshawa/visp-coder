import { compareUnknowns } from "../extract/unknowns.js";
import type { EntrypointKind, UnknownRecord } from "../types.js";
import { byKey, entityRow, entrypointRow, relationRow } from "./rows.js";
import type { SnapshotIndex } from "./snapshot-index.js";
import type { QueryArgs, QueryDraft, RepoSummary } from "./types.js";

/** Operations that read the snapshot directly, without traversing it. */

export function describe(index: SnapshotIndex): QueryDraft {
  const snapshot = index.snapshot;
  const counts = new Map<EntrypointKind, number>();
  for (const entrypoint of snapshot.entrypoints) {
    counts.set(entrypoint.kind, (counts.get(entrypoint.kind) ?? 0) + 1);
  }

  const summary: RepoSummary = {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    files: snapshot.files.length,
    entities: snapshot.entities.length,
    relations: snapshot.relations.length,
    unknowns: snapshot.unknowns.length,
    entrypoints: snapshot.entrypoints.length,
    languageCoverage: snapshot.languageCoverage,
    entrypointCounts: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
  };

  return {
    rows: snapshot.entrypoints.map(entrypointRow).sort(byKey),
    unknowns: [...snapshot.unknowns].sort(compareUnknowns),
    notes: coverageNotes(index),
    summary,
  };
}

function coverageNotes(index: SnapshotIndex): string[] {
  return index.snapshot.languageCoverage
    .filter((entry) => entry.parsedFiles < entry.totalFiles)
    .map((entry) => `${entry.language}: ${entry.parsedFiles}/${entry.totalFiles} files parsed`);
}

export function search(index: SnapshotIndex, args: QueryArgs): QueryDraft {
  const term = (args.name ?? "").toLowerCase();
  const path = args.path;

  // A path alone lists what a file defines, which is how someone asks "what is
  // in here" before naming a symbol.
  if (term === "" && path === undefined) return empty(["search requires a name or a path"]);

  const matches = index.snapshot.entities.filter(
    (entity) =>
      entity.kind !== "file" &&
      (term === "" || entity.name.toLowerCase().includes(term)) &&
      (path === undefined || entity.path === path),
  );
  const paths = new Set(matches.map((entity) => entity.path));

  return {
    rows: matches.map((entity) => entityRow(entity)).sort(byKey),
    unknowns: relevantUnknowns(index, paths, term),
    notes: matches.length === 0 ? [describeMiss(args)] : [],
  };
}

function describeMiss(args: QueryArgs): string {
  if (args.name && args.path) return `no entity named "${args.name}" in ${args.path}`;
  if (args.path) return `${args.path} defines nothing, or is not in the index`;
  return `no entity name contains "${args.name}"`;
}

export function entity(index: SnapshotIndex, args: QueryArgs): QueryDraft {
  const reference = args.entity ?? args.path;
  if (!reference) return empty(["entity requires an entity id or path"]);

  const found = index.resolveTarget(reference);
  if (!found) return empty([`no entity named ${reference} in this snapshot`]);

  const relations = [...index.out(found.id), ...index.in(found.id)];
  return {
    rows: [entityRow(found), ...relations.map(relationRow)].sort(byKey),
    unknowns: index.unknownsFor([found.path]).sort(compareUnknowns),
    notes: [],
  };
}

export function unknowns(index: SnapshotIndex, args: QueryArgs): QueryDraft {
  const filtered = index.snapshot.unknowns.filter(
    (record) => args.kind === undefined || record.kind === args.kind,
  );
  return {
    rows: [],
    unknowns: [...filtered].sort(compareUnknowns),
    notes: args.kind ? [`filtered to kind ${args.kind}`] : [],
  };
}

function relevantUnknowns(
  index: SnapshotIndex,
  paths: ReadonlySet<string>,
  term: string,
): UnknownRecord[] {
  const byName = index.snapshot.unknowns.filter((record) =>
    record.detail.toLowerCase().includes(term),
  );
  return [...new Set([...index.unknownsFor(paths), ...byName])].sort(compareUnknowns);
}

function empty(notes: string[]): QueryDraft {
  return { rows: [], unknowns: [], notes };
}
