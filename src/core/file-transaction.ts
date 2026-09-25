import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { STATE_DIR } from "./constants.js";
import { fromUnknown, vispError } from "./errors.js";
import { ProjectFileSystem } from "./fs.js";
import { sha256 } from "./hash.js";
import { isInside, isPortableAbsolute } from "./paths.js";
import { err, ok, type Result } from "./result.js";
import { withStateLock } from "./state-lock.js";

const JOURNAL_VERSION = 1;
const TRANSACTIONS_DIR = `${STATE_DIR}/state/transactions`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const activeJournals = new Set<string>();

/** Recover before reading inputs to a mutation, while holding the same writer ownership. */
export function withStateMutation<T>(
  root: string,
  operation: () => Promise<Result<T>>,
): Promise<Result<T>> {
  return withStateLock(root, async () => {
    const recovered = await recoverLocked(root);
    return recovered.ok ? operation() : recovered;
  });
}

export type FilePrecondition =
  | { readonly existed: false }
  | { readonly existed: true; readonly hash: string; readonly mode?: number };

interface MutationPrecondition {
  /** State observed while planning; prevents a later snapshot legitimising a concurrent edit. */
  readonly expectedBefore?: FilePrecondition;
}

export type FileMutation =
  | (MutationPrecondition & {
      readonly kind: "write";
      readonly path: string;
      readonly content: string | Uint8Array;
      readonly mode?: number;
    })
  | (MutationPrecondition & { readonly kind: "remove"; readonly path: string });

interface FileSnapshot {
  readonly existed: boolean;
  readonly content?: string;
  readonly hash?: string;
  readonly mode?: number;
}

interface JournalEntry {
  readonly kind: FileMutation["kind"];
  readonly path: string;
  readonly before: FileSnapshot;
  readonly afterHash?: string;
  readonly afterMode?: number;
}

interface TransactionJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly state: "prepared" | "committed";
  readonly entries: readonly JournalEntry[];
}

export interface FileTransactionOutcome {
  readonly id?: string;
  readonly changed: number;
}

export interface TransactionInspection {
  readonly pending: readonly string[];
  readonly committed: readonly string[];
}

/** Builds an exact content precondition from a value observed during planning. */
export function filePrecondition(
  content: string | Uint8Array | undefined,
  mode?: number,
): FilePrecondition {
  if (content === undefined) return { existed: false };
  return {
    existed: true,
    hash: sha256(bytesOf(content)),
    ...(mode === undefined ? {} : { mode }),
  };
}

/**
 * Project storage that reconciles an interrupted transaction immediately before
 * the next mutation. Reads stay side-effect free, so status/next never migrate
 * or repair files merely by loading a workspace.
 *
 * Transaction internals deliberately use the base ProjectFileSystem: recovering
 * while a new journal is being applied would roll that same transaction back.
 */
export class RecoveringProjectFileSystem extends ProjectFileSystem {
  private readonly recovering = new AsyncLocalStorage<{ active: boolean }>();

  override ensureDir(path: string): Promise<Result<void>> {
    return this.withRecovery(() => super.ensureDir(path));
  }

  override writeBytesAtomic(
    path: string,
    content: Uint8Array,
    mode = 0o644,
  ): Promise<Result<void>> {
    return this.withRecovery(() => super.writeBytesAtomic(path, content, mode));
  }

  override removeFile(path: string): Promise<Result<void>> {
    return this.withRecovery(() => super.removeFile(path));
  }

  override removeDir(path: string): Promise<Result<void>> {
    return this.withRecovery(() => super.removeDir(path));
  }

  override rename(from: string, to: string): Promise<Result<void>> {
    return this.withRecovery(() => super.rename(from, to));
  }

  override chmod(path: string, mode: number): Promise<Result<void>> {
    return this.withRecovery(() => super.chmod(path, mode));
  }

  private async withRecovery<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.recovering.getStore()?.active) return operation();
    return withStateLock(this.root, async () => {
      const scope = { active: true };
      try {
        return await this.recovering.run(scope, async () => {
          const recovered = await recoverFileTransactions(this.root);
          return recovered.ok ? operation() : err(recovered.error);
        });
      } finally {
        scope.active = false;
      }
    });
  }
}

interface ApplyOptions {
  /** Dependency hook used by fault-injection tests. */
  readonly afterMutation?: (applied: number) => void | Promise<void>;
  /** Models process termination: leave the prepared journal for recovery. */
  readonly leavePreparedOnError?: boolean;
}

/**
 * Applies a planned group of file changes as one recoverable unit.
 *
 * Every pre-image is written to a recoverable journal before the first target
 * changes. A normal error rolls back immediately; a process interruption
 * leaves the prepared journal for the next mutating command to recover. This
 * protocol does not claim power-loss durability because it does not fsync file
 * and directory entries.
 */
export async function applyFileTransaction(
  root: string,
  label: string,
  mutations: readonly FileMutation[],
  options: ApplyOptions = {},
): Promise<Result<FileTransactionOutcome>> {
  return withStateLock(root, () => applyLocked(root, label, mutations, options));
}

async function applyLocked(
  root: string,
  label: string,
  mutations: readonly FileMutation[],
  options: ApplyOptions,
): Promise<Result<FileTransactionOutcome>> {
  const recovered = await recoverFileTransactions(root);
  if (!recovered.ok) return recovered;
  if (mutations.length === 0) return ok({ changed: 0 });

  const fs = new ProjectFileSystem(root);
  const prepared = await prepareJournal(fs, root, label, mutations);
  if (!prepared.ok) return prepared;

  const journalPath = journalFile(prepared.value.id);
  const activeKey = join(await realpath(root), prepared.value.id);
  activeJournals.add(activeKey);
  try {
    const recorded = await fs.writeJson(journalPath, prepared.value);
    if (!recorded.ok) return recorded;

    const applied = await applyPreparedMutations(fs, mutations, prepared.value, options);
    if (!applied.ok) {
      return handleApplyFailure(fs, journalPath, prepared.value, applied.error, options);
    }

    const complete = await verifyAppliedJournal(fs, prepared.value);
    if (!complete.ok) {
      return handleApplyFailure(fs, journalPath, prepared.value, complete.error, options);
    }

    const committed: TransactionJournal = { ...prepared.value, state: "committed" };
    const marked = await fs.writeJson(journalPath, committed);
    if (!marked.ok)
      return handleApplyFailure(fs, journalPath, prepared.value, marked.error, options);

    const removed = await fs.removeFile(journalPath);
    if (!removed.ok) return removed;
    await cleanEmptyJournalDirectories(fs);
    return ok({ id: prepared.value.id, changed: mutations.length });
  } finally {
    activeJournals.delete(activeKey);
  }
}

/** Recovers every prepared journal and removes committed journal debris. */
export async function recoverFileTransactions(root: string): Promise<Result<string[]>> {
  return withStateLock(root, () => recoverLocked(root));
}

async function recoverLocked(root: string): Promise<Result<string[]>> {
  const canonical = await realpath(root);
  const fs = new ProjectFileSystem(root);
  const journals = await readJournals(fs);
  if (!journals.ok) return journals;

  const recovered: string[] = [];
  for (const { path, journal } of journals.value) {
    if (activeJournals.has(join(canonical, journal.id))) continue;
    if (journal.state === "prepared") {
      const restored = await restoreJournal(fs, journal);
      if (!restored.ok) return restored;
      recovered.push(journal.id);
    }
    const removed = await fs.removeFile(path);
    if (!removed.ok) return removed;
  }
  await cleanEmptyJournalDirectories(fs);
  return ok(recovered);
}

/** Read-only transaction health for doctor. */
export async function inspectFileTransactions(
  root: string,
): Promise<Result<TransactionInspection>> {
  const fs = new ProjectFileSystem(root);
  const journals = await readJournals(fs);
  if (!journals.ok) return journals;
  return ok({
    pending: journals.value
      .filter(({ journal }) => journal.state === "prepared")
      .map(({ journal }) => journal.id),
    committed: journals.value
      .filter(({ journal }) => journal.state === "committed")
      .map(({ journal }) => journal.id),
  });
}

async function prepareJournal(
  fs: ProjectFileSystem,
  requestedRoot: string,
  label: string,
  mutations: readonly FileMutation[],
): Promise<Result<TransactionJournal>> {
  const seen = new Set<string>();
  const entries: JournalEntry[] = [];

  for (const mutation of mutations) {
    const entry = await prepareEntry(fs, requestedRoot, mutation, seen);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }

  return ok({
    version: JOURNAL_VERSION,
    id: randomUUID(),
    label,
    createdAt: new Date().toISOString(),
    state: "prepared",
    entries,
  });
}

async function prepareEntry(
  fs: ProjectFileSystem,
  requestedRoot: string,
  mutation: FileMutation,
  seen: Set<string>,
): Promise<Result<JournalEntry>> {
  const path = relativePath(fs.root, requestedRoot, mutation.path);
  if (!path.ok) return path;
  if (seen.has(path.value)) {
    return err(vispError("INTERNAL", `Transaction contains duplicate target: ${path.value}`));
  }
  seen.add(path.value);

  const metadata = await fs.metadata(path.value);
  if (!metadata.ok) return metadata;
  if (metadata.value && metadata.value.type !== "file") {
    return err(vispError("IO_ERROR", `Transaction target is not a file: ${path.value}`));
  }
  const bytes = await fs.readBytesIfExists(path.value);
  if (!bytes.ok) return bytes;
  const before = snapshot(bytes.value, metadata.value?.mode);
  if (mutation.expectedBefore && !matchesPrecondition(before, mutation.expectedBefore)) {
    return err(
      vispError("IO_ERROR", `Concurrent change detected while planning ${path.value}`, {
        details: { path: path.value },
      }),
    );
  }
  if (mutation.kind === "remove") return ok({ kind: mutation.kind, path: path.value, before });

  const content = bytesOf(mutation.content);
  return ok({
    kind: mutation.kind,
    path: path.value,
    before,
    afterHash: sha256(content),
    afterMode: mutation.mode ?? metadata.value?.mode ?? 0o644,
  });
}

async function applyPreparedMutations(
  fs: ProjectFileSystem,
  mutations: readonly FileMutation[],
  journal: TransactionJournal,
  options: ApplyOptions,
): Promise<Result<void>> {
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    const entry = journal.entries[index];
    const applied = await applyPreparedMutation(fs, mutation, entry, index, options);
    if (!applied.ok) return applied;
  }
  return ok(undefined);
}

async function applyPreparedMutation(
  fs: ProjectFileSystem,
  mutation: FileMutation | undefined,
  entry: JournalEntry | undefined,
  index: number,
  options: ApplyOptions,
): Promise<Result<void>> {
  if (!mutation || !entry) {
    return err(vispError("INTERNAL", "Transaction plan and journal diverged"));
  }
  const unchanged = await matchesSnapshot(fs, entry.path, entry.before);
  if (!unchanged.ok) return unchanged;
  if (!unchanged.value) {
    return err(vispError("IO_ERROR", `Concurrent change detected while updating ${entry.path}`));
  }
  const changed = await applyMutation(fs, mutation, entry);
  if (!changed.ok) return changed;
  const verified = await matchesAfter(fs, entry);
  if (!verified.ok) return verified;
  if (!verified.value) {
    return err(vispError("IO_ERROR", `Transaction could not verify ${entry.path}`));
  }
  try {
    await options.afterMutation?.(index + 1);
    return ok(undefined);
  } catch (cause) {
    return err(fromUnknown(cause));
  }
}

async function matchesAfter(fs: ProjectFileSystem, entry: JournalEntry): Promise<Result<boolean>> {
  const metadata = await fs.metadata(entry.path);
  if (!metadata.ok) return metadata;
  const bytes = await fs.readBytesIfExists(entry.path);
  if (!bytes.ok) return bytes;
  if (entry.kind === "remove") return ok(bytes.value === undefined && metadata.value === undefined);
  return ok(
    bytes.value !== undefined &&
      metadata.value?.type === "file" &&
      sameMode(metadata.value.mode, entry.afterMode) &&
      sha256(bytes.value) === entry.afterHash,
  );
}

async function verifyAppliedJournal(
  fs: ProjectFileSystem,
  journal: TransactionJournal,
): Promise<Result<void>> {
  for (const entry of journal.entries) {
    const current = await matchesAfter(fs, entry);
    if (!current.ok) return current;
    if (!current.value) {
      return err(
        vispError("IO_ERROR", `Transaction target changed before commit: ${entry.path}`, {
          details: { transaction: journal.id, path: entry.path },
        }),
      );
    }
  }
  return ok(undefined);
}

async function handleApplyFailure(
  fs: ProjectFileSystem,
  journalPath: string,
  journal: TransactionJournal,
  failure: ReturnType<typeof vispError>,
  options: ApplyOptions,
): Promise<Result<FileTransactionOutcome>> {
  if (options.leavePreparedOnError) return err(failure);
  const rolledBack = await restoreJournal(fs, journal);
  if (!rolledBack.ok) {
    return err(
      vispError(
        "IO_ERROR",
        `${failure.message}; rollback also failed: ${rolledBack.error.message}`,
        {
          recovery: "Run visp doctor --fix before making more changes",
          details: { transaction: journal.id },
        },
      ),
    );
  }
  const removed = await fs.removeFile(journalPath);
  if (!removed.ok) return removed;
  await cleanEmptyJournalDirectories(fs);
  return err(failure);
}

async function applyMutation(
  fs: ProjectFileSystem,
  mutation: FileMutation,
  entry: JournalEntry,
): Promise<Result<void>> {
  // Guards restate unchanged files; the precondition check already proved them.
  // Rewriting them touched every file and failed where hosts protect agent directories.
  if (alreadyInPlace(entry)) return ok(undefined);
  if (mutation.kind === "remove") return fs.removeFile(entry.path);
  return fs.writeBytesAtomic(entry.path, bytesOf(mutation.content), entry.afterMode ?? 0o644);
}

function alreadyInPlace(entry: JournalEntry): boolean {
  if (entry.kind === "remove") return !entry.before.existed;
  return (
    entry.before.existed &&
    entry.before.hash === entry.afterHash &&
    sameMode(entry.before.mode, entry.afterMode)
  );
}

async function restoreJournal(
  fs: ProjectFileSystem,
  journal: TransactionJournal,
): Promise<Result<void>> {
  const applied: JournalEntry[] = [];
  for (const entry of journal.entries) {
    const current = await classifyRecoveryEntry(fs, journal.id, entry);
    if (!current.ok) return current;
    if (current.value === "applied") applied.push(entry);
  }

  // Classify the entire journal before touching anything. If even one target
  // has a third state, recovery must preserve every byte for manual resolution
  // rather than leave a surprising partial rollback.
  for (const entry of applied.reverse()) {
    const restored = await restoreEntry(fs, entry);
    if (!restored.ok) return restored;
  }
  return ok(undefined);
}

async function classifyRecoveryEntry(
  fs: ProjectFileSystem,
  transaction: string,
  entry: JournalEntry,
): Promise<Result<"restored" | "applied">> {
  const alreadyRestored = await matchesSnapshot(fs, entry.path, entry.before);
  if (!alreadyRestored.ok) return alreadyRestored;
  if (alreadyRestored.value) return ok("restored");

  const stillApplied = await matchesAfter(fs, entry);
  if (!stillApplied.ok) return stillApplied;
  if (stillApplied.value) return ok("applied");
  return err(
    vispError("IO_ERROR", `Transaction recovery found a divergent file: ${entry.path}`, {
      recovery:
        "Preserve or reconcile the external edit, then run visp doctor --fix before making more changes",
      details: { transaction, path: entry.path },
    }),
  );
}

function restoreEntry(fs: ProjectFileSystem, entry: JournalEntry): Promise<Result<void>> {
  return entry.before.existed
    ? fs.writeBytesAtomic(
        entry.path,
        Buffer.from(entry.before.content ?? "", "base64"),
        entry.before.mode ?? 0o644,
      )
    : fs.removeFile(entry.path);
}

async function matchesSnapshot(
  fs: ProjectFileSystem,
  path: string,
  expected: FileSnapshot,
): Promise<Result<boolean>> {
  const metadata = await fs.metadata(path);
  if (!metadata.ok) return metadata;
  const bytes = await fs.readBytesIfExists(path);
  if (!bytes.ok) return bytes;
  if (!expected.existed) return ok(bytes.value === undefined && metadata.value === undefined);
  return ok(
    bytes.value !== undefined &&
      metadata.value?.type === "file" &&
      sameMode(metadata.value.mode, expected.mode) &&
      sha256(bytes.value) === expected.hash,
  );
}

function sameMode(actual: number | undefined, expected: number | undefined): boolean {
  return process.platform === "win32" || actual === expected;
}

function snapshot(content: Uint8Array | undefined, mode: number | undefined): FileSnapshot {
  if (content === undefined) return { existed: false };
  return {
    existed: true,
    content: Buffer.from(content).toString("base64"),
    hash: sha256(content),
    mode: mode ?? 0o644,
  };
}

function matchesPrecondition(actual: FileSnapshot, expected: FilePrecondition): boolean {
  if (!expected.existed) return !actual.existed;
  return (
    actual.existed &&
    actual.hash === expected.hash &&
    (expected.mode === undefined || sameMode(actual.mode, expected.mode))
  );
}

async function readJournals(
  fs: ProjectFileSystem,
): Promise<Result<{ path: string; journal: TransactionJournal }[]>> {
  const entries = await fs.listDir(TRANSACTIONS_DIR);
  if (!entries.ok) return entries;

  const journals: { path: string; journal: TransactionJournal }[] = [];
  for (const name of entries.value.filter((entry) => entry.endsWith(".json"))) {
    const path = `${TRANSACTIONS_DIR}/${name}`;
    const parsed = await fs.readJson(path, parseJournal);
    if (!parsed.ok) return parsed;
    if (name !== `${parsed.value.id}.json`) {
      return err(
        vispError("ARTIFACT_INVALID", `Transaction journal name does not match its id: ${name}`),
      );
    }
    journals.push({ path, journal: parsed.value });
  }
  return ok(journals);
}

function parseJournal(value: unknown): Result<TransactionJournal> {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION) {
    return err(vispError("ARTIFACT_INVALID", "Invalid VISP file transaction journal"));
  }
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.label !== "string" ||
    value.label.trim() === "" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    (value.state !== "prepared" && value.state !== "committed") ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    return err(vispError("ARTIFACT_INVALID", "Malformed VISP file transaction journal"));
  }

  const entries: JournalEntry[] = [];
  const paths = new Set<string>();
  for (const raw of value.entries) {
    const parsed = parseEntry(raw);
    if (!parsed.ok) return parsed;
    if (paths.has(parsed.value.path)) {
      return err(vispError("ARTIFACT_INVALID", "Duplicate path in VISP transaction journal"));
    }
    paths.add(parsed.value.path);
    entries.push(parsed.value);
  }
  return ok({
    version: JOURNAL_VERSION,
    id: value.id,
    label: value.label,
    createdAt: value.createdAt,
    state: value.state,
    entries,
  });
}

function parseEntry(value: unknown): Result<JournalEntry> {
  if (
    !isRecord(value) ||
    (value.kind !== "write" && value.kind !== "remove") ||
    typeof value.path !== "string" ||
    !isJournalPath(value.path) ||
    !isRecord(value.before) ||
    typeof value.before.existed !== "boolean"
  ) {
    return err(vispError("ARTIFACT_INVALID", "Malformed VISP transaction entry"));
  }
  const before = value.before;
  const existed = before.existed;
  if (!validBeforeSnapshot(before, existed)) {
    return err(vispError("ARTIFACT_INVALID", "Malformed VISP transaction entry metadata"));
  }
  if (
    (value.kind === "write" && (!isSha256(value.afterHash) || !isFileMode(value.afterMode))) ||
    (value.kind === "remove" && (value.afterHash !== undefined || value.afterMode !== undefined))
  ) {
    return err(vispError("ARTIFACT_INVALID", "Malformed VISP transaction post-image"));
  }
  const beforeSnapshot: FileSnapshot =
    existed === true
      ? {
          existed: true,
          content: before.content as string,
          hash: before.hash as string,
          mode: before.mode as number,
        }
      : { existed: false };
  return value.kind === "write"
    ? ok({
        kind: "write",
        path: value.path,
        before: beforeSnapshot,
        afterHash: value.afterHash as string,
        afterMode: value.afterMode as number,
      })
    : ok({ kind: "remove", path: value.path, before: beforeSnapshot });
}

function validBeforeSnapshot(before: Record<string, unknown>, existed: unknown): boolean {
  if (existed === false) {
    return before.content === undefined && before.hash === undefined && before.mode === undefined;
  }
  if (
    existed !== true ||
    typeof before.content !== "string" ||
    !BASE64.test(before.content) ||
    !isSha256(before.hash) ||
    !isFileMode(before.mode)
  ) {
    return false;
  }
  const decoded = Buffer.from(before.content, "base64");
  return decoded.toString("base64") === before.content && sha256(decoded) === before.hash;
}

function isJournalPath(path: string): boolean {
  return (
    path !== "" &&
    path !== "." &&
    !path.includes("\\") &&
    !isPortableAbsolute(path) &&
    !path.split("/").includes("..") &&
    posix.normalize(path) === path
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isFileMode(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o777;
}

function relativePath(root: string, requestedRoot: string, path: string): Result<string> {
  if (path.split(/[\\/]/).includes("..") || (isPortableAbsolute(path) && !isAbsolute(path))) {
    return err(vispError("IO_ERROR", `Invalid transaction target: ${path}`));
  }
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  // ProjectFileSystem accepts the caller's root alias; journals retain one relative identity.
  const base = isInside(root, absolute) ? root : resolve(requestedRoot);
  const rel = relative(base, absolute).replaceAll("\\", "/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return err(vispError("IO_ERROR", `Transaction target is outside the project: ${path}`));
  }
  return ok(rel);
}

function journalFile(id: string): string {
  return join(TRANSACTIONS_DIR, `${id}.json`);
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cleanEmptyJournalDirectories(fs: ProjectFileSystem): Promise<void> {
  await fs.removeDir(TRANSACTIONS_DIR).catch(() => undefined);
  await fs.removeDir(`${STATE_DIR}/state`).catch(() => undefined);
  await fs.removeDir(STATE_DIR).catch(() => undefined);
}
