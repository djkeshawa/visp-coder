import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { vispError } from "../../core/errors.js";
import { run } from "../../core/exec.js";
import {
  applyFileTransaction,
  type FileMutation,
  type FilePrecondition,
  filePrecondition,
} from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { isPortableAbsolute } from "../../core/paths.js";
import { matchesAny } from "../../core/patterns.js";
import { privatePath } from "../../core/redaction.js";
import { err, ok, type Result } from "../../core/result.js";
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
    omitted: z.literal(true).optional(),
    mode: z.number().int().optional(),
    symlink: z.literal(true).optional(),
    hash: z.string(),
  })
  .strict();
const MAX_FILES = 2000;
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
    files: z.array(fileSchema).max(MAX_FILES),
    /** Too large to copy: identity and evidence only, never restorable. */
    identityOnly: z.literal(true).optional(),
    brief: z.string().optional(),
    productState: z.string(),
    evidence: z.unknown(),
  })
  .strict();
export type ProductCandidate = z.infer<typeof candidateSchema>;
const MAX_BYTES = 32 * 1024 * 1024;
export const candidatePath = (workspace: WorkspaceState, feature: string, id: string) =>
  join(workspace.paths.featureDir(feature), `candidates/${id}.json`);

/**
 * Exact bytes, including binary assets, deletions and modes; generated evidence is stored separately
 * from source. A product larger than one copy (an existing repository under a broad scope) still
 * gets its review: the candidate then records identity and evidence only and cannot be restored.
 */
export async function prepareCandidate(
  workspace: WorkspaceState,
  selected: CriticSelection,
  evidence: unknown,
) {
  const preconditions = new Map<string, FilePrecondition>();
  const snapshot = await productSourceSnapshot(workspace, selected.record.brief, preconditions);
  if (!snapshot.ok) return snapshot;
  const paths = candidateSourcePaths(
    workspace,
    selected.record.brief,
    snapshot.value,
    selected.slice,
  );
  const captured =
    paths.length > MAX_FILES ? undefined : await captureFiles(workspace, paths, snapshot.value);
  if (captured && !captured.ok) return captured;
  const subject = await productSourceDigest(workspace, selected.record.brief, snapshot.value);
  if (!subject.ok) return subject;
  const copied: ProductCandidate = {
    version: 1,
    id: `CAN-${randomUUID().replaceAll("-", "")}`,
    root: hashValue(workspace.paths.root),
    feature: selected.selection.feature,
    task: selected.selection.task,
    subject: subject.value,
    contract: selected.contract,
    intent: selected.intent,
    files: captured?.value?.files ?? [],
    ...(captured?.value ? {} : { identityOnly: true as const }),
    productState: json({ executions: selected.record.state.executions }),
    evidence: compactEvidence(evidence),
  };
  const fits = Buffer.byteLength(json(copied)) <= MAX_BYTES;
  const candidate: ProductCandidate = fits
    ? copied
    : { ...copied, files: [], identityOnly: true as const };
  const content = json(candidate);
  if (Buffer.byteLength(content) > MAX_BYTES)
    return err(vispError("UNSUPPORTED", "Candidate evidence exceeds 32 MiB"));
  const guards = candidate.identityOnly
    ? assertionGuards(paths, preconditions)
    : ok(captured?.value?.guards ?? []);
  if (!guards.ok) return guards;
  return ok({
    candidate,
    snapshot: snapshot.value,
    mutations: [
      ...guards.value,
      {
        kind: "write" as const,
        path: candidatePath(workspace, candidate.feature, candidate.id),
        content,
        expectedBefore: filePrecondition(undefined),
      },
    ],
  });
}

function assertionGuards(
  paths: readonly string[],
  preconditions: ReadonlyMap<string, FilePrecondition>,
) {
  const guards: FileMutation[] = [];
  for (const path of paths) {
    const expectedBefore = preconditions.get(path);
    if (!expectedBefore)
      return err(vispError("INTERNAL", "Candidate snapshot is missing source preconditions"));
    guards.push({ kind: "assert", path, expectedBefore });
  }
  return ok(guards);
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

/** Source bytes of declared paths, or undefined when they exceed one candidate's 32 MiB. */
async function captureFiles(
  workspace: WorkspaceState,
  paths: readonly string[],
  snapshot: Record<string, string>,
): Promise<Result<{ files: ProductCandidate["files"]; guards: FileMutation[] } | undefined>> {
  const files: ProductCandidate["files"] = [];
  const guards: FileMutation[] = [];
  let bytes = 0;
  const ignored = await ignoredPaths(workspace, [...paths]);
  if (!ignored.ok) return ignored;
  for (const path of paths) {
    const omitted =
      ignored.value.has(path) ||
      privatePath(path) ||
      privatePath(path, workspace.config.workflow.blockedPaths);
    // Sizes decide before reading; a file that grows while being read still fails capture.
    const size = omitted ? 0 : await declaredSize(workspace, path);
    if (typeof size !== "number") return size;
    if (bytes + size > MAX_BYTES) return ok(undefined);
    const captured = await captureFile(workspace, path, snapshot[path] ?? "", bytes, omitted);
    if (!captured.ok) return captured;
    bytes += captured.value.bytes;
    files.push(captured.value.file);
    guards.push(captured.value.guard);
  }
  return ok({ files, guards });
}

/** A link's own size, as capture stores the link, never its target's. */
async function declaredSize(workspace: WorkspaceState, path: string) {
  const link = await workspace.files.readSymbolicLink(path);
  if (!link.ok) return link;
  if (link.value !== undefined) return link.value.length;
  const metadata = await workspace.files.readMetadata(path);
  return metadata.ok ? (metadata.value?.size ?? 0) : metadata;
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
  if (candidate.value.identityOnly)
    return err(
      vispError(
        "UNSUPPORTED",
        `Candidate ${id} recorded identity only: its source exceeded ${MAX_FILES} files or 32 MiB`,
        {
          recovery:
            "Return to the reviewed state with git (for example git stash or git checkout).",
        },
      ),
    );
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
  omitted: boolean,
) {
  const read = await readSourceEntry(
    workspace.files,
    path,
    omitted ? MAX_BYTES : MAX_BYTES - bytes,
  );
  if (!read.ok) return read;
  const entry = read.value;
  const hash = sourceEntryHash(entry.bytes, entry.mode, entry.symlink);
  if (hash !== expected)
    return err(vispError("EVIDENCE_FAILED", "Source changed during candidate capture"));
  const file = {
    path,
    content:
      omitted || entry.bytes === undefined ? null : Buffer.from(entry.bytes).toString("base64"),
    mode: entry.mode,
    ...(entry.symlink ? { symlink: true as const } : {}),
    hash,
    ...(omitted ? { omitted: true as const } : {}),
  };
  return ok({
    file,
    guard: sourceEntryMutation(path, entry, entry),
    bytes: omitted ? 0 : (entry.bytes?.length ?? 0),
  });
}

function validateFiles(candidate: ProductCandidate) {
  if (new Set(candidate.files.map((f) => f.path)).size !== candidate.files.length)
    throw new Error("duplicates");
  for (const file of candidate.files) validateFile(file);
}

function validateFile(file: ProductCandidate["files"][number]) {
  if (file.omitted) {
    if (file.content !== null || !/^[a-f0-9]{64}$/.test(file.hash))
      throw new Error("private input");
    return;
  }
  const bytes = file.content === null ? undefined : Buffer.from(file.content, "base64");
  if (bytes && bytes.toString("base64") !== file.content) throw new Error("encoding");
  if (
    sourceEntryHash(bytes, file.mode, file.symlink) !== file.hash ||
    (file.symlink &&
      (bytes === undefined || bytes.length === 0 || bytes.includes(0) || file.mode !== 0o777))
  )
    throw new Error("hash");
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
    const refusal = restorationError(workspace, slice, path, file);
    if (refusal) return err(refusal);
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

async function ignoredPaths(workspace: WorkspaceState, paths: string[]) {
  const ignored = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += 100) {
    const result = await run("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
      cwd: workspace.paths.root,
      input: `${paths.slice(offset, offset + 100).join("\0")}\0`,
    });
    if (!result.ok) return result;
    if (result.value.exitCode > 1)
      return err(vispError("COMMAND_FAILED", "Cannot determine ignored candidate inputs"));
    for (const path of result.value.stdout.split("\0").filter(Boolean)) ignored.add(path);
  }
  return ok(ignored);
}

function compactEvidence(evidence: unknown): unknown {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
  const { images, ...rest } = evidence as Record<string, unknown>;
  return {
    ...rest,
    ...(Array.isArray(images)
      ? { images: images.map((image) => ({ id: image.id, sha256: image.sha256 })) }
      : {}),
  };
}

function privateInput(workspace: WorkspaceState, path: string) {
  return privatePath(path) || privatePath(path, workspace.config.workflow.blockedPaths);
}

function restorationError(
  workspace: WorkspaceState,
  slice: ProductSlice,
  path: string,
  file?: ProductCandidate["files"][number],
) {
  if (file?.omitted || privateInput(workspace, path))
    return vispError(
      "SCOPE_VIOLATION",
      `Cannot restore private input ${path}; only its hash was saved`,
    );
  if (
    path.startsWith(".visp/") ||
    !matchesAny(path, slice.scope.allowed) ||
    matchesAny(path, slice.scope.forbidden)
  )
    return vispError("SCOPE_VIOLATION", `Restoration would change out-of-scope file: ${path}`);
  return undefined;
}
