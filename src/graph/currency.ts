import type { GraphConfig } from "../config/schema.js";
import { ok, type Result } from "../core/result.js";
import { MAX_CURRENCY_PATHS } from "./constants.js";
import { extractionInputs } from "./extract/identity.js";
import { diffFiles } from "./refresh.js";
import type { GraphSnapshot } from "./types.js";
import { walkRepository, worktreeFingerprint } from "./walker/index.js";

/**
 * Whether the graph is still true of the worktree. This is an observation for a
 * caller to weigh, never a verdict that blocks: `unverified` says the check
 * itself could not be made.
 */

export type CurrencyState = "current" | "divergent" | "unverified";

export interface CurrencyReport {
  readonly state: CurrencyState;
  readonly snapshotId: string;
  readonly fingerprint: string;
  readonly worktreeFingerprint: string | undefined;
  readonly added: string[];
  readonly changed: string[];
  readonly deleted: string[];
  /** True when a list was cut at the cap, so counts are exact but lists are not. */
  readonly listsTruncated: boolean;
  readonly counts: { readonly added: number; readonly changed: number; readonly deleted: number };
  readonly reason?: string;
}

export async function checkCurrency(
  root: string,
  snapshot: GraphSnapshot,
  config: GraphConfig,
): Promise<Result<CurrencyReport>> {
  const walked = await walkRepository(root, config);
  if (!walked.ok) return ok(unverified(snapshot, walked.error.message));

  const fingerprint = worktreeFingerprint(walked.value.files);
  const extraction = await extractionInputs(root, config);
  const extractionChanged = snapshot.extractionFingerprint !== extraction.fingerprint;
  const hashes = new Map(snapshot.files.map((file) => [file.path, file.hash]));
  const diff = diffFiles(walked.value.files, hashes);
  const total = diff.added.length + diff.changed.length + diff.deleted.length;

  return ok({
    state:
      total === 0 && fingerprint === snapshot.fingerprint && !extractionChanged
        ? "current"
        : "divergent",
    ...(extractionChanged
      ? { reason: "Extraction configuration or runtime changed; refresh the index" }
      : {}),
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    worktreeFingerprint: fingerprint,
    added: cap(diff.added),
    changed: cap(diff.changed),
    deleted: cap(diff.deleted),
    listsTruncated:
      diff.added.length > MAX_CURRENCY_PATHS ||
      diff.changed.length > MAX_CURRENCY_PATHS ||
      diff.deleted.length > MAX_CURRENCY_PATHS,
    counts: {
      added: diff.added.length,
      changed: diff.changed.length,
      deleted: diff.deleted.length,
    },
  });
}

function unverified(snapshot: GraphSnapshot, reason: string): CurrencyReport {
  return {
    state: "unverified",
    snapshotId: snapshot.id,
    fingerprint: snapshot.fingerprint,
    worktreeFingerprint: undefined,
    added: [],
    changed: [],
    deleted: [],
    listsTruncated: false,
    counts: { added: 0, changed: 0, deleted: 0 },
    reason,
  };
}

function cap(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_CURRENCY_PATHS);
}
