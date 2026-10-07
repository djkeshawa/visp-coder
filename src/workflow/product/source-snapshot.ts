import { vispError } from "../../core/errors.js";
import { type FilePrecondition, filePrecondition } from "../../core/file-transaction.js";
import type { ProjectFileSystem } from "../../core/fs.js";
import type { GitSourceEntry } from "../../core/git-source.js";
import { matchesAny } from "../../core/patterns.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { inspectSourceEntry, readSourceEntry, sourcePreconditionHash } from "./source-entry.js";
import { repositorySourceIdentity } from "./source-git.js";

export const INPUT_LIMITS = {
  entries: 20_000,
  depth: 64,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
};
export interface InputBudget {
  entries: number;
  bytes: number;
}
export function inputLimit(path: string) {
  return err(
    vispError(
      "UNSUPPORTED",
      `Product evidence input budget exceeded at ${path}; declared slice scopes and check inputs exceed the snapshot budget`,
      {
        details: INPUT_LIMITS,
        recovery:
          "Narrow slice scopes and check file patterns, or reduce oversized declared inputs. A pattern that starts with a wildcard skips tool directories (node_modules, dist, build, .venv and similar) unless it names them. Other tracked files use Git identities and do not consume this budget.",
      },
    ),
  );
}

export async function productFileHash(
  workspace: WorkspaceState,
  path: string,
  budget: InputBudget,
  preconditions?: Map<string, FilePrecondition>,
): Promise<Result<string>> {
  budget.entries += 1;
  if (budget.entries > INPUT_LIMITS.entries) return inputLimit(path);
  const entry = await readSourceEntry(
    workspace.files,
    path,
    Math.min(INPUT_LIMITS.fileBytes, INPUT_LIMITS.totalBytes - budget.bytes),
  );
  if (!entry.ok) return entry;
  budget.bytes += entry.value.bytes?.byteLength ?? 0;
  const precondition = filePrecondition(entry.value.bytes, entry.value.mode, entry.value.symlink);
  preconditions?.set(path, precondition);
  return ok(sourcePreconditionHash(precondition, entry.value.mode));
}

interface HashedInput {
  hash: Result<string>;
  metadataBytes?: number;
  bytes: number;
  symlink: boolean;
  precondition?: FilePrecondition;
}
const SNAPSHOT_CONCURRENCY = 24;

export async function snapshotSourceFiles(
  workspace: WorkspaceState,
  paths: string[],
  patterns: string[],
  objects: { entries: Map<string, GitSourceEntry>; dirty: Set<string> },
  algorithm: "sha1" | "sha256",
  preconditions?: Map<string, FilePrecondition>,
): Promise<Result<Record<string, string>>> {
  const selected = new Set(paths.filter((path) => matchesAny(path, patterns)));
  const files: Record<string, string> = {};
  const budget: InputBudget = { entries: 0, bytes: 0 };
  // Retain only hashes for one batch, never the whole repository's byte buffers.
  for (let offset = 0; offset < paths.length; offset += SNAPSHOT_CONCURRENCY) {
    const batch = paths.slice(offset, offset + SNAPSHOT_CONCURRENCY);
    const inputs: HashedInput[] = await Promise.all(
      batch.map(async (path) =>
        selected.has(path)
          ? readInput(workspace.files, path)
          : {
              hash: await repositorySourceIdentity(workspace, path, objects, algorithm),
              bytes: 0,
              symlink: false,
            },
      ),
    );
    for (const [index, path] of batch.entries()) {
      const input = inputs[index];
      if (!input) continue;
      const hash = selected.has(path) ? budgetedHash(path, input, budget) : input.hash;
      if (!hash.ok) return hash;
      if (input.precondition) preconditions?.set(path, input.precondition);
      files[path] = hash.value;
    }
  }
  return ok(files);
}

function budgetedHash(path: string, input: HashedInput, budget: InputBudget): Result<string> {
  budget.entries += 1;
  if (budget.entries > INPUT_LIMITS.entries) return inputLimit(path);
  const maxBytes = Math.min(INPUT_LIMITS.fileBytes, INPUT_LIMITS.totalBytes - budget.bytes);
  // The old reader checked metadata before attempting the read. Preserve
  // that error precedence, including when a speculative read failed.
  if (input.metadataBytes !== undefined && input.metadataBytes > maxBytes) return byteLimit(path);
  if (!input.hash.ok) return input.hash;
  if (!input.symlink && input.bytes > maxBytes) return byteLimit(path);
  budget.bytes += input.bytes;
  return input.hash;
}

function byteLimit(path: string) {
  return err(vispError("UNSUPPORTED", `Product evidence input budget exceeded at ${path}`));
}

async function readInput(files: ProjectFileSystem, path: string): Promise<HashedInput> {
  const inspected = await inspectSourceEntry(files, path);
  if (!inspected.ok) return { hash: inspected, bytes: 0, symlink: false };
  const { link, metadata } = inspected.value;
  if (link !== undefined) {
    const precondition = filePrecondition(link, 0o777, true);
    return {
      hash: ok(sourcePreconditionHash(precondition, 0o777)),
      precondition,
      bytes: link.length,
      symlink: true,
    };
  }
  const metadataBytes = metadata?.size ?? 0;
  if (metadataBytes > INPUT_LIMITS.fileBytes)
    return { hash: byteLimit(path), metadataBytes, bytes: 0, symlink: false };
  const read = await files.readBytesIfExists(path);
  if (!read.ok) return { hash: read, metadataBytes, bytes: 0, symlink: false };
  const precondition = filePrecondition(read.value, metadata?.mode);
  return {
    hash: ok(sourcePreconditionHash(precondition, metadata?.mode)),
    precondition,
    metadataBytes,
    bytes: read.value?.length ?? 0,
    symlink: false,
  };
}
