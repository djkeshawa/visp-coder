import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { vispError } from "../../core/errors.js";
import {
  applyFileTransaction,
  type FileMutation,
  filePrecondition,
} from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { isPortableAbsolute } from "../../core/paths.js";
import { matchesAny } from "../../core/patterns.js";
import { err, ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { type CriticSelection, recordGuards } from "./critic-store.js";
import type { ProductSlice } from "./model.js";
import { checkProductScope } from "./scopes.js";
import { readSourceEntry, sourceEntryHash, sourceEntryMutation } from "./source-entry.js";
import { candidateSourcePaths } from "./source-inputs.js";
import { json } from "./store.js";
import { productSourceDigest, productSourceSnapshot } from "./subject.js";

const pathSchema = z
  .string()
  .refine(
    (path) =>
      !!path &&
      !isPortableAbsolute(path) &&
      !path.includes("\0") &&
      !path.includes("\\") &&
      !path.split("/").some((part) => ["", ".", "..", ".git"].includes(part)),
  );
const fileSchema = z
  .object({
    path: pathSchema,
    content: z.string().nullable(),
    mode: z.number().int().optional(),
    symlink: z.literal(true).optional(),
    hash: z.string(),
  })
  .strict();
const candidateSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^CAN-[a-f0-9]{32}$/),
    root: z.string(),
    feature: z.string(),
    task: z.string().optional(),
    subject: z.string(),
    contract: z.string(),
    intent: z.string(),
    files: z.array(fileSchema).max(2000),
    brief: z.string(),
    productState: z.string(),
    evidence: z.unknown(),
  })
  .strict();
export type ProductCandidate = z.infer<typeof candidateSchema>;
const MAX_BYTES = 32 * 1024 * 1024;
export const candidatePath = (workspace: WorkspaceState, feature: string, id: string) =>
  join(workspace.paths.featureDir(feature), `candidates/${id}.json`);

/** Exact bytes, including binary assets, deletions and modes; generated evidence is stored separately from source. */
export async function prepareCandidate(
  workspace: WorkspaceState,
  selected: CriticSelection,
  evidence: unknown,
) {
  const snapshot = await productSourceSnapshot(workspace, selected.record.brief);
  if (!snapshot.ok) return snapshot;
  const paths = candidateSourcePaths(
    workspace,
    selected.record.brief,
    snapshot.value,
    selected.slice,
  );
  if (paths.length > 2000)
    return err(
      vispError("UNSUPPORTED", "Candidate exceeds 2000 declared source files", {
        recovery: "Narrow this slice's scope and check inputs before preserving a candidate.",
      }),
    );
  const files: ProductCandidate["files"] = [];
  const guards: FileMutation[] = [];
  let bytes = 0;
  for (const path of paths) {
    const expected = snapshot.value[path] ?? "";
    const captured = await captureFile(workspace, path, expected, bytes);
    if (!captured.ok) return captured;
    bytes += captured.value.bytes;
    files.push(captured.value.file);
    guards.push(captured.value.guard);
  }
  const subject = await productSourceDigest(workspace, selected.record.brief, snapshot.value);
  if (!subject.ok) return subject;
  const candidate: ProductCandidate = {
    version: 1,
    id: `CAN-${randomUUID().replaceAll("-", "")}`,
    root: hashValue(workspace.paths.root),
    feature: selected.selection.feature,
    task: selected.selection.task,
    subject: subject.value,
    contract: selected.contract,
    intent: selected.intent,
    files,
    brief: selected.record.briefText,
    productState: selected.record.stateText,
    evidence,
  };
  const content = json(candidate);
  if (Buffer.byteLength(content) > MAX_BYTES)
    return err(vispError("UNSUPPORTED", "Candidate source and evidence exceed 32 MiB"));
  return ok({
    candidate,
    snapshot: snapshot.value,
    mutations: [
      ...guards,
      {
        kind: "write" as const,
        path: candidatePath(workspace, candidate.feature, candidate.id),
        content,
        expectedBefore: filePrecondition(undefined),
      },
    ],
  });
}

export async function readCandidate(
  workspace: WorkspaceState,
  selected: CriticSelection,
  id: string,
) {
  if (!/^CAN-[a-f0-9]{32}$/.test(id))
    return err(vispError("ARTIFACT_INVALID", "Invalid candidate ID"));
  const path = candidatePath(workspace, selected.selection.feature, id);
  const meta = await workspace.files.readMetadata(path);
  if (!meta.ok) return meta;
  if ((meta.value?.size ?? 0) > MAX_BYTES)
    return err(vispError("ARTIFACT_INVALID", "Oversized candidate"));
  const read = await workspace.files.readText(path);
  if (!read.ok) return read;
  try {
    const candidate = candidateSchema.parse(JSON.parse(read.value));
    if (
      candidate.id !== id ||
      candidate.root !== hashValue(workspace.paths.root) ||
      candidate.feature !== selected.selection.feature ||
      candidate.task !== selected.selection.task ||
      candidate.intent !== selected.intent
    )
      throw new Error("identity");
    validateFiles(candidate);
    return ok(candidate);
  } catch {
    return err(
      vispError("ARTIFACT_INVALID", "Candidate content, contract or worktree identity is invalid"),
    );
  }
}

/** Explicit restore is guarded by current subject, current authorization and original scope. Never restores acceptance or evidence as fresh. */
export async function restoreCandidate(
  workspace: WorkspaceState,
  selected: CriticSelection,
  id: string,
  expectedSubject: string,
) {
  if (!selected.slice)
    return err(
      vispError(
        "NO_ACTIVE_TASK",
        "Candidate restoration requires an explicitly selected authorized slice",
      ),
    );
  const scoped = await checkProductScope(workspace, selected.record, selected.slice);
  if (!scoped.ok) return scoped;
  const candidate = await readCandidate(workspace, selected, id);
  if (!candidate.ok) return candidate;
  const current = await productSourceSnapshot(workspace, selected.record.brief);
  if (!current.ok) return current;
  const subject = await productSourceDigest(workspace, selected.record.brief, current.value);
  if (!subject.ok) return subject;
  if (subject.value !== expectedSubject)
    return err(vispError("EVIDENCE_FAILED", "Source changed since the restore request"));
  const selectedCurrent = Object.fromEntries(
    candidateSourcePaths(workspace, selected.record.brief, current.value, selected.slice).map(
      (path) => [path, current.value[path] ?? ""],
    ),
  );
  const planned = await planRestore(workspace, selected.slice, selectedCurrent, candidate.value);
  if (!planned.ok) return planned;
  const result = await applyFileTransaction(workspace.paths.root, "restore-product-candidate", [
    ...recordGuards(workspace, selected.record),
    ...planned.value,
  ]);
  return result.ok
    ? ok({
        restored: id,
        changed: result.value.changed,
        acceptance: "unchanged; run applicable checks and review",
        command: `visp verify --feature ${selected.selection.feature} --task ${selected.slice.id}`,
      })
    : result;
}

async function captureFile(
  workspace: WorkspaceState,
  path: string,
  expected: string,
  bytes: number,
) {
  const read = await readSourceEntry(workspace.files, path, MAX_BYTES - bytes);
  if (!read.ok) return read;
  const entry = read.value;
  const hash = sourceEntryHash(entry.bytes, entry.mode, entry.symlink);
  if (hash !== expected)
    return err(vispError("EVIDENCE_FAILED", "Source changed during candidate capture"));
  const file = {
    path,
    content: entry.bytes === undefined ? null : Buffer.from(entry.bytes).toString("base64"),
    mode: entry.mode,
    ...(entry.symlink ? { symlink: true as const } : {}),
    hash,
  };
  return ok({
    file,
    guard: sourceEntryMutation(path, entry, entry),
    bytes: entry.bytes?.length ?? 0,
  });
}

function validateFiles(candidate: ProductCandidate) {
  if (new Set(candidate.files.map((f) => f.path)).size !== candidate.files.length)
    throw new Error("duplicates");
  for (const file of candidate.files) {
    const bytes = file.content === null ? undefined : Buffer.from(file.content, "base64");
    if (bytes && bytes.toString("base64") !== file.content) throw new Error("encoding");
    if (
      sourceEntryHash(bytes, file.mode, file.symlink) !== file.hash ||
      (file.symlink &&
        (bytes === undefined || bytes.length === 0 || bytes.includes(0) || file.mode !== 0o777))
    )
      throw new Error("hash");
  }
}

async function planRestore(
  workspace: WorkspaceState,
  slice: ProductSlice,
  current: Record<string, string>,
  candidate: ProductCandidate,
) {
  const files = new Map(candidate.files.map((f) => [f.path, f]));
  const mutations: FileMutation[] = [];
  for (const path of new Set([...Object.keys(current), ...files.keys()])) {
    const file = files.get(path);
    if (file?.hash === current[path]) continue;
    if (
      path.startsWith(".visp/") ||
      !matchesAny(path, slice.scope.allowed) ||
      matchesAny(path, slice.scope.forbidden)
    )
      return err(
        vispError("SCOPE_VIOLATION", `Restoration would change out-of-scope file: ${path}`),
      );
    const before = await readSourceEntry(workspace.files, path, MAX_BYTES);
    if (!before.ok) return before;
    const entry = before.value;
    if (
      current[path] === undefined
        ? entry.bytes !== undefined
        : sourceEntryHash(entry.bytes, entry.mode, entry.symlink) !== current[path]
    )
      return err(vispError("EVIDENCE_FAILED", "Concurrent source edit during restore"));
    mutations.push(
      sourceEntryMutation(path, entry, {
        bytes: file?.content == null ? undefined : Buffer.from(file.content, "base64"),
        mode: file?.mode,
        symlink: file?.symlink,
      }),
    );
  }
  return ok(mutations);
}
