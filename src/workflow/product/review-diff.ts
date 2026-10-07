import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { run } from "../../core/exec.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { privatePath } from "../../core/redaction.js";
import { GENERATED_AGENT_PREFIXES } from "../../graph/paths.js";
import type { WorkspaceState } from "../state.js";
import type { ProductSlice } from "./model.js";
import { diffDefinitions, enclosingDiffContext } from "./review-diff-context.js";
import { readProductAuthorizationBaseline } from "./scopes.js";
import { sourceEntryHash } from "./source-entry.js";
import type { ProductSource } from "./sources.js";
import type { ProductRecord } from "./store.js";

export const REVIEW_DIFF_BUDGET = 12800;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const FILE_BYTES = 8 * 1024 * 1024;
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };

interface DiffFile {
  path: string;
  patch: string;
}

function sourcePath(path: string) {
  return (
    !privatePath(path) &&
    !GENERATED_AGENT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    !/(^|\/)(?:AGENTS\.md|CLAUDE\.md|visp\.ya?ml)$/i.test(path) &&
    !path.split("/").some((part) => part === ".." || part === ".git") &&
    !/[\r\n\0]/.test(path)
  );
}

/** Reconstruct only identities we can verify; HEAD is never a substitute for a dirty baseline. */
export async function reviewDiffSource(
  workspace: WorkspaceState,
  record: ProductRecord,
  changed: ReadonlySet<string>,
  slice?: ProductSlice,
): Promise<ProductSource | undefined> {
  if (!changed.size || !workspace.paths) return undefined;
  const authorization = await readProductAuthorizationBaseline(workspace, record);
  if (!authorization.ok || !authorization.value) return undefined;
  const auth = authorization.value;
  if (slice && auth.task !== slice.id) return undefined;
  const controls = new Set(
    [workspace.paths.config, workspace.paths.policy, workspace.paths.overrides].map((path) =>
      workspace.paths.relative(path),
    ),
  );
  const paths = [...changed]
    .filter(
      (path) =>
        sourcePath(path) &&
        !controls.has(path) &&
        auth.baseline[path] !== undefined &&
        auth.baseline[path] !== sourceEntryHash(undefined),
    )
    .sort();
  if (!paths.length) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "visp-review-diff-"));
  try {
    const files = await collectDiffFiles(
      workspace,
      paths,
      auth.baseline,
      auth.headCommit,
      directory,
    );
    const source: ProductSource = {
      id: `CODE-DIFF-${sha256(JSON.stringify([auth.baseline, files])).slice(0, 16)}`,
      kind: "implementation-diff",
      reference: "Source changes against the work-authorization baseline",
      sha256: sha256(JSON.stringify(files)),
      available: true,
      excerpt: files.map((file) => file.patch).join("\n"),
    };
    return fitReviewDiff(source, REVIEW_DIFF_BUDGET);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collectDiffFiles(
  workspace: WorkspaceState,
  paths: string[],
  baseline: Record<string, string>,
  head: string | undefined,
  directory: string,
) {
  await mkdir(join(directory, "before"));
  await mkdir(join(directory, "after"));
  const files: DiffFile[] = paths.map((path) => ({
    path,
    patch: `Changed: ${JSON.stringify(path)}; baseline bytes unavailable; not shown.`,
  }));
  const requests = paths.map((path) =>
    baseline[path]?.startsWith("git:")
      ? baseline[path]?.split(":")[2]
      : head
        ? `${head}:${path}`
        : undefined,
  );
  const objects = await baselineObjects(workspace.paths.root, requests);
  const names = new Map<
    string,
    { file: DiffFile; definitions: ReturnType<typeof diffDefinitions> }
  >();
  const budget = { bytes: 0 };
  for (const [index, file] of files.entries()) {
    const entry = await diffEntry(
      workspace,
      file,
      objects[index],
      baseline[file.path] ?? "",
      budget,
    );
    if (!entry) continue;
    const extension = /^\.[a-z0-9]+$/i.test(extname(file.path)) ? extname(file.path) : ".txt";
    const name = `file${index}${extension}`;
    file.patch = `Changed: ${JSON.stringify(file.path)}; no text or executable-bit change; permission metadata not shown.`;
    names.set(name, { file, definitions: diffDefinitions(file.path, entry.old, entry.current) });
    await materializeEntry(directory, name, entry);
  }
  if (!names.size) return files;
  await readUnifiedDiff(directory, names);
  return files;
}

interface DiffEntry {
  old: Buffer;
  current: Uint8Array | undefined;
  oldExecutable: boolean;
  currentExecutable: boolean;
}

async function diffEntry(
  workspace: WorkspaceState,
  file: DiffFile,
  old: Buffer | undefined,
  identity: string,
  budget: { bytes: number },
): Promise<DiffEntry | undefined> {
  const link = await workspace.files.readSymbolicLink(file.path);
  const metadata = await workspace.files.readMetadata(file.path);
  if (
    !link.ok ||
    link.value !== undefined ||
    !metadata.ok ||
    (metadata.value && metadata.value.type !== "file")
  ) {
    file.patch = `Changed: ${JSON.stringify(file.path)}; unsupported entry; not shown.`;
    return undefined;
  }
  const size = metadata.value?.size ?? 0;
  if (
    Math.max(size, old?.length ?? 0) > FILE_BYTES ||
    budget.bytes + size + (old?.length ?? 0) > SNAPSHOT_BYTES
  ) {
    file.patch = `Changed: ${JSON.stringify(file.path)}; snapshot byte limit; not shown.`;
    return undefined;
  }
  const read = await workspace.files.readBytesIfExists(file.path);
  if (!read.ok) return undefined;
  const current = read.value;
  budget.bytes += (old?.length ?? 0) + (current?.length ?? 0);
  if ([old, current].some((value) => value && (!isUtf8(value) || value.includes(0)))) {
    file.patch = `Changed: ${JSON.stringify(file.path)}; binary or non-UTF-8 file; not shown.`;
    return undefined;
  }
  if (!old) return undefined;
  const oldMode = baselineMode(old, identity);
  if (oldMode === undefined) return undefined;
  return {
    old,
    current,
    oldExecutable: Boolean(oldMode & 0o111),
    currentExecutable: Boolean((metadata.value?.mode ?? 0) & 0o111),
  };
}

async function materializeEntry(directory: string, name: string, entry: DiffEntry) {
  await writeFile(join(directory, "before", name), entry.old);
  await chmod(join(directory, "before", name), entry.oldExecutable ? 0o755 : 0o644);
  if (entry.current !== undefined) {
    await writeFile(join(directory, "after", name), entry.current);
    await chmod(join(directory, "after", name), entry.currentExecutable ? 0o755 : 0o644);
  }
}

async function readUnifiedDiff(
  directory: string,
  names: ReadonlyMap<string, { file: DiffFile; definitions: ReturnType<typeof diffDefinitions> }>,
) {
  // One diff for the entire preparation; never a per-file diff or a live-index mutation.
  const diff = await run(
    "git",
    [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "-U8",
      "--",
      "before",
      "after",
    ],
    { cwd: directory, env: GIT_ENV, timeoutMs: 30000 },
  );
  if (
    !diff.ok ||
    diff.value.exitCode > 1 ||
    /^\[VISP: output truncated\]$/m.test(diff.value.stdout)
  ) {
    for (const { file } of names.values())
      file.patch = `Changed: ${JSON.stringify(file.path)}; diff unavailable or exceeds output limit; hunks not shown.`;
    return;
  }
  for (const patch of diff.value.stdout.split(/(?=^diff --git )/m)) {
    const name = /^diff --git a\/(?:before|after)\/([^ ]+) b\/(?:before|after)\//.exec(patch)?.[1];
    const materialized = name ? names.get(name) : undefined;
    if (!materialized) continue;
    const { file, definitions } = materialized;
    file.patch = enclosingDiffContext(patch, definitions)
      .replace(
        /^diff --git .*$/m,
        `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}`,
      )
      .replace(/^--- (?!\/dev\/null).*$/m, `--- ${JSON.stringify(`a/${file.path}`)}`)
      .replace(/^\+\+\+ (?!\/dev\/null).*$/m, `+++ ${JSON.stringify(`b/${file.path}`)}`);
  }
}

export function baselineMode(bytes: Buffer, identity: string, symlink = false): number | undefined {
  if (!identity.startsWith("git:")) {
    // The snapshot retains actual permission bits, while Git retains only the executable bit.
    const hash = sha256(bytes);
    for (let mode = 0; mode <= 0o777; mode++)
      if (hashValue({ hash, mode, ...(symlink ? { type: "symlink" } : {}) }) === identity)
        return mode;
    return undefined;
  }
  return gitBaselineMode(bytes, identity, symlink);
}

/** One bounded batch, retaining bytes so encoding fixtures cannot corrupt following entries. */
export async function baselineObjects(root: string, requests: (string | undefined)[]) {
  const selected = requests.filter((request): request is string => request !== undefined);
  const output = selected.length
    ? await new Promise<Buffer | undefined>((resolve) => {
        const child = execFile(
          "git",
          ["cat-file", "--batch"],
          {
            cwd: root,
            env: { ...process.env, ...GIT_ENV },
            encoding: "buffer",
            maxBuffer: SNAPSHOT_BYTES,
            timeout: 30000,
          },
          (error, stdout) => resolve(error ? undefined : stdout),
        );
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(`${selected.join("\n")}\n`);
      })
    : undefined;
  let offset = 0;
  return requests.map((request) => {
    if (!request || !output) return undefined;
    const end = output.indexOf(10, offset);
    if (end < 0) return undefined;
    const header = output.subarray(offset, end).toString("utf8");
    offset = end + 1;
    const size = /^[a-f0-9]+ blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) return undefined;
    const bytes = output.subarray(offset, offset + Number(size));
    offset += Number(size) + 1;
    return bytes;
  });
}

function diffFiles(text: string): DiffFile[] {
  return text
    .split(/(?=^diff --git |^Changed: )/m)
    .filter((part) => part.trim())
    .map((patch) => ({
      path:
        /^diff --git "a\/(.*)" "b\//.exec(patch)?.[1] ??
        /^Changed: (".*?");/.exec(patch)?.[1] ??
        "unknown file",
      patch: patch.trimEnd(),
    }));
}

function omittedRange(hunk: string) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk);
  if (!match) return "previously omitted regions";
  const [, old = "0", oldCount = "1", next = "0", nextCount = "1"] = match;
  return `old ${old}-${Number(old) + Math.max(0, Number(oldCount) - 1)}, new ${next}-${Number(next) + Math.max(0, Number(nextCount) - 1)}`;
}

function boundedFile(file: DiffFile, budget: number) {
  const escapedCost = (text: string) => JSON.stringify(text).length;
  if (escapedCost(file.patch) <= budget) return file.patch;
  const hunks = file.patch.split(/(?=^@@ )/m);
  const header = hunks.shift() ?? "";
  const note = `\nOmitted hunks: ${file.path}: ${hunks.map(omittedRange).join("; ") || "file metadata or earlier cutoff"}.\n`;
  let shown = header;
  const room = budget - escapedCost(header + note);
  if (room > 0) shown += changedHunkExcerpt(hunks, room);
  return shown + note;
}

function changedHunkExcerpt(hunks: string[], budget: number) {
  const cost = (text: string) => JSON.stringify(text).length;
  let shown = "";
  for (const hunk of hunks) {
    if (cost(shown + hunk) <= budget) {
      shown += hunk;
      continue;
    }
    const lines = hunk.trimEnd().split("\n");
    const anchors = [
      0,
      lines.findIndex((line) => line.startsWith("-")),
      lines.findIndex((line) => line.startsWith("+")),
    ].filter((index) => index >= 0);
    for (const context of [2, 1, 0]) {
      const excerpt = hunkLines(lines, anchors, context);
      if (cost(shown + excerpt) <= budget) return shown + excerpt;
    }
    // Very long changed lines still retain both signs; the file's range note discloses truncation.
    let width = Math.floor((budget - cost(shown)) / Math.max(1, anchors.length)) - 40;
    while (width > 0) {
      const clipped = lines.map((line) =>
        line.length > width ? `${line.slice(0, width)} [line truncated]` : line,
      );
      const excerpt = hunkLines(clipped, anchors, 0);
      if (cost(shown + excerpt) <= budget) return shown + excerpt;
      width = Math.floor(width * 0.8);
    }
    break;
  }
  return shown;
}

function hunkLines(lines: string[], anchors: number[], context: number) {
  const selected = new Set(
    anchors
      .flatMap((anchor) =>
        Array.from({ length: context * 2 + 1 }, (_, offset) => anchor - context + offset),
      )
      .filter((index) => index >= 0 && index < lines.length),
  );
  const indexes = [...selected].sort((a, b) => a - b);
  return indexes
    .map(
      (index, position) =>
        `${position > 0 && index > (indexes[position - 1] ?? 0) + 1 ? "[hunk lines omitted]\n" : ""}${lines[index]}\n`,
    )
    .join("");
}

/** Fit annotated diff hunks within the same fair per-file allocation. */
export function fitReviewDiff(source: ProductSource, budget: number): ProductSource | undefined {
  if (JSON.stringify(source).length + 1 <= budget) return source;
  const base = { ...source, excerpt: "", truncated: true, nextRead: undefined };
  const files = diffFiles(source.excerpt);
  const room = budget - JSON.stringify(base).length - 1;
  if (room <= 0) return undefined;
  let share = Math.floor((room - files.length * 2) / files.length);
  while (share > 0) {
    const excerpt = files.map((file) => boundedFile(file, share)).join("\n");
    const fitted = { ...base, excerpt, truncated: source.truncated || excerpt !== source.excerpt };
    if (JSON.stringify(fitted).length + 1 <= budget) return fitted;
    share = Math.floor(share * 0.8);
  }
  // Even the file/range inventory cannot fit. Disclose the cutoff rather than silently dropping it.
  const excerpt = `Changed files omitted from diff: ${files.length}; identity digest: ${sha256(source.excerpt)}. First omitted: ${files[0]?.path.slice(0, 160)}. Hunks not shown.`;
  const fitted = { ...base, excerpt };
  return JSON.stringify(fitted).length + 1 <= budget ? fitted : undefined;
}

function gitBaselineMode(bytes: Buffer, identity: string, symlink: boolean) {
  const [, mode, object = ""] = identity.split(":");
  if (symlink ? mode !== "120000" : mode !== "100644" && mode !== "100755") return undefined;
  const observed = createHash(object.length === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  if (observed !== object) return undefined;
  if (symlink) return 0o777;
  return mode === "100755" ? 0o755 : 0o644;
}
