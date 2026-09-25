import type { GraphConfig } from "../config/schema.js";
import { RecoveringProjectFileSystem } from "../core/file-transaction.js";
import type { ProjectFileSystem } from "../core/fs.js";
import { ok, type Result } from "../core/result.js";
import { extractionInputs } from "./extract/identity.js";
import { computeLanguageCoverage, dedupeRelations, extractRepository } from "./extract/index.js";
import { mergeFacts } from "./merge.js";
import { type GraphProjection, projectGraph, reverseImportClosure } from "./projection.js";
import { type GraphStore, openProjectStore } from "./store/index.js";
import type { FileEntry, GraphSnapshot, LanguageCoverage, SkippedFile } from "./types.js";
import { walkRepository, worktreeFingerprint } from "./walker/index.js";

/**
 * Indexing is incremental by default: only files whose content hash moved are
 * re-parsed, and a refresh with nothing to do says so instead of pretending to
 * work.
 */

export interface FileDiff {
  readonly added: string[];
  readonly changed: string[];
  readonly deleted: string[];
  readonly unchanged: string[];
}

export interface IndexReport {
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly diff: FileDiff;
  readonly noChange: boolean;
  readonly filesParsed: number;
  readonly filesReused: number;
  readonly relationsInvalidated: number;
  readonly skipped: SkippedFile[];
  readonly languageCoverage: LanguageCoverage[];
  readonly counts: {
    readonly files: number;
    readonly entities: number;
    readonly relations: number;
    readonly unknowns: number;
    readonly entrypoints: number;
  };
}

export type IndexMode = "full" | "incremental";

export function diffFiles(
  current: readonly FileEntry[],
  previous: ReadonlyMap<string, string>,
): FileDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();

  for (const file of current) {
    seen.add(file.path);
    const before = previous.get(file.path);
    if (before === undefined) added.push(file.path);
    else if (before === file.hash) unchanged.push(file.path);
    else changed.push(file.path);
  }

  const deleted = [...previous.keys()].filter((path) => !seen.has(path));
  return {
    added: added.sort(),
    changed: changed.sort(),
    deleted: deleted.sort(),
    unchanged: unchanged.sort(),
  };
}

export async function indexRepository(
  root: string,
  config: GraphConfig,
  storePath: string,
): Promise<Result<IndexReport>> {
  return runIndex(root, config, storePath, "full");
}

export async function refreshRepository(
  root: string,
  config: GraphConfig,
  storePath: string,
): Promise<Result<IndexReport>> {
  return runIndex(root, config, storePath, "incremental");
}

export async function runIndex(
  root: string,
  config: GraphConfig,
  storePath: string,
  mode: IndexMode,
): Promise<Result<IndexReport>> {
  const files = new RecoveringProjectFileSystem(root);
  const store = await openProjectStore(files, storePath, { writable: true });
  if (!store.ok) return store;
  try {
    return await withStore(store.value, files, root, config, mode);
  } finally {
    store.value.close();
  }
}

async function withStore(
  store: GraphStore,
  files: ProjectFileSystem,
  root: string,
  config: GraphConfig,
  mode: IndexMode,
): Promise<Result<IndexReport>> {
  const walked = await walkRepository(root, config);
  if (!walked.ok) return walked;

  const previousResult = mode === "incremental" ? store.readHead() : ok(undefined);
  if (!previousResult.ok) return previousResult;
  // A copied index cannot be reused as this checkout's extraction baseline.
  const previous = previousResult.value?.root === root ? previousResult.value : undefined;

  const fingerprint = worktreeFingerprint(walked.value.files);
  const extraction = await extractionInputs(root, config);
  const extractionChanged = previous?.extractionFingerprint !== extraction.fingerprint;
  const diff = diffFiles(walked.value.files, hashesOf(previous));

  if (previous && !extractionChanged && isUnchanged(diff) && previous.fingerprint === fingerprint) {
    return ok(unchangedReport(previous, diff, walked.value.skipped));
  }

  const previousProjection =
    mode === "incremental" && previous ? projectGraph(previous) : undefined;
  const seeds =
    mode === "full" || extractionChanged
      ? walked.value.files.map((file) => file.path)
      : parseSet(diff, previousProjection);
  const reparse = new Set(
    previousProjection ? reverseImportClosure(previousProjection, seeds) : seeds,
  );

  const reusablePaths = new Set(
    previous ? diff.unchanged.filter((path) => !reparse.has(path)) : [],
  );
  const knownEntities = previous?.entities.filter((entity) => reusablePaths.has(entity.path));

  const extracted = await extractRepository({
    root,
    files: walked.value.files,
    parseFiles: walked.value.files.filter((file) => reparse.has(file.path)),
    skipped: walked.value.skipped,
    languages: config.languages,
    knownEntities,
    aliases: extraction.aliases,
    readSource: (path) => files.readText(path),
  });
  if (!extracted.ok) return extracted;

  const livePaths = new Set(walked.value.files.map((file) => file.path));
  const merged = mergeFacts(extracted.value, previous, reusablePaths, livePaths);
  const parsedPaths = new Set([...extracted.value.parsedPaths, ...merged.reusedParsedPaths]);

  const published = store.publishSnapshot({
    root,
    createdAt: new Date().toISOString(),
    fingerprint,
    extractionFingerprint: extraction.fingerprint,
    files: walked.value.files,
    entities: merged.entities,
    relations: dedupeRelations(merged.relations),
    unknowns: merged.unknowns,
    entrypoints: merged.entrypoints,
    languageCoverage: computeLanguageCoverage(walked.value.files, parsedPaths),
  });
  if (!published.ok) return published;

  return ok(
    report(published.value, diff, walked.value.skipped, {
      filesParsed: extracted.value.parsedPaths.length,
      filesReused: merged.reusedParsedPaths.size,
      relationsInvalidated: merged.invalidated,
      noChange: false,
    }),
  );
}

interface ReportExtras {
  readonly filesParsed: number;
  readonly filesReused: number;
  readonly relationsInvalidated: number;
  readonly noChange: boolean;
}

function report(
  snapshot: GraphSnapshot,
  diff: FileDiff,
  skipped: SkippedFile[],
  extras: ReportExtras,
): IndexReport {
  return {
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    diff,
    skipped,
    languageCoverage: snapshot.languageCoverage,
    counts: {
      files: snapshot.files.length,
      entities: snapshot.entities.length,
      relations: snapshot.relations.length,
      unknowns: snapshot.unknowns.length,
      entrypoints: snapshot.entrypoints.length,
    },
    ...extras,
  };
}

function unchangedReport(
  previous: GraphSnapshot,
  diff: FileDiff,
  skipped: SkippedFile[],
): IndexReport {
  return report(previous, diff, skipped, {
    filesParsed: 0,
    filesReused: diff.unchanged.length,
    relationsInvalidated: 0,
    noChange: true,
  });
}

function isUnchanged(diff: FileDiff): boolean {
  return diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0;
}

/**
 * Seeds for an incremental refresh. Deleted paths stay as closure anchors so
 * unchanged importers can replace their now-dangling facts. An added path has
 * no previous incoming edge, so prior unresolved-import sources are conservative
 * candidates; their old reverse closure catches importers without scanning the
 * whole repository.
 */
function parseSet(diff: FileDiff, previous?: GraphProjection): string[] {
  const seeds = [...diff.added, ...diff.changed, ...diff.deleted];
  if (diff.added.length > 0 && previous) {
    seeds.push(
      ...previous.unknowns
        .filter((unknown) => unknown.kind === "unresolved_import")
        .map((unknown) => unknown.path),
    );
  }
  return [...new Set(seeds)].sort();
}

function hashesOf(snapshot: GraphSnapshot | undefined): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const file of snapshot?.files ?? []) hashes.set(file.path, file.hash);
  return hashes;
}
