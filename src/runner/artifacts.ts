import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { canonicalJson, hashValue, sha256 } from "../core/hash.js";
import { git } from "./process.js";

export function assertOutside(parent: string, candidate: string): void {
  const path = relative(parent, candidate);
  if (
    !path ||
    (!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      path !== ".." &&
      !isAbsolute(path))
  ) {
    throw new Error(
      "Runner artifacts and evaluator policy must be outside the candidate repository",
    );
  }
}

export function immutableJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface JournalEvent {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
  readonly previousHash: string;
  readonly payload: unknown;
  readonly hash: string;
}
export class EventJournal {
  count = 0;
  head: string;
  constructor(
    readonly directory: string,
    readonly runId: string,
    manifestHash: string,
  ) {
    this.head = manifestHash;
  }
  append(payload: unknown): void {
    const event = {
      schemaVersion: 1 as const,
      runId: this.runId,
      sequence: this.count + 1,
      at: new Date().toISOString(),
      previousHash: this.head,
      payload,
    };
    const hash = hashValue(event);
    immutableJson(join(this.directory, `${String(event.sequence).padStart(8, "0")}.json`), {
      ...event,
      hash,
    });
    this.count = event.sequence;
    this.head = hash;
  }
}

export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string(),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().nonnegative(),
          executable: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type SourceSnapshot = z.infer<typeof snapshotSchema>;

export async function captureSnapshot(
  worktree: string,
  runDirectory: string,
  revision: string,
): Promise<SourceSnapshot> {
  const listed = await git(worktree, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const files: SourceSnapshot["files"] = [];
  let total = 0;
  await mkdir(join(runDirectory, "objects"), { recursive: true, mode: 0o700 });
  for (const path of [...new Set(listed.split("\0").filter(Boolean))].sort()) {
    const absolute = safeChild(worktree, path);
    const file = await readSnapshotFile(absolute, path);
    if (!file) continue;
    const { content, executable } = file;
    total += content.length;
    if (total > 256 * 1024 * 1024 || files.length >= 25_000)
      throw new Error("Source snapshot exceeded its documented file/byte limit");
    const hash = sha256(content);
    await storeSourceObject(join(runDirectory, "objects", hash), content, hash);
    files.push({
      path,
      sha256: hash,
      bytes: content.length,
      executable,
    });
  }
  return { schemaVersion: 1, revision, files };
}

async function readSnapshotFile(absolute: string, path: string) {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  if (info.isSymbolicLink())
    throw new Error(`Snapshot refuses symlink ${path} -> ${await readlink(absolute)}`);
  if (!info.isFile()) throw new Error(`Snapshot requires a regular file: ${path}`);
  if ((await realpath(absolute)) !== resolve(absolute))
    throw new Error(`Snapshot refuses symlink parent: ${path}`);
  if (info.size > 20 * 1024 * 1024) throw new Error("Source file exceeds 20 MiB snapshot limit");
  return { content: await readFile(absolute), executable: Boolean(info.mode & 0o111) };
}

async function storeSourceObject(
  destination: string,
  content: Buffer,
  hash: string,
): Promise<void> {
  try {
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    if (sha256(await readFile(destination)) !== hash)
      throw new Error("Existing source object failed integrity verification");
  }
}

export function safeChild(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new Error(`Invalid artifact path: ${path}`);
  return join(root, path);
}

export async function verifyJournal(
  directory: string,
  runId: string,
  manifestHash: string,
  count: number,
  expectedHead: string,
): Promise<JournalEvent | undefined> {
  const names = (await readdir(directory)).sort();
  if (names.length !== count) throw new Error("Event count failed integrity verification");
  let head = manifestHash;
  let last: JournalEvent | undefined;
  for (let index = 0; index < names.length; index += 1) {
    const name = `${String(index + 1).padStart(8, "0")}.json`;
    if (names[index] !== name) throw new Error("Event sequence is incomplete");
    const value = JSON.parse(await readFile(join(directory, name), "utf8")) as JournalEvent;
    const { hash, ...content } = value;
    if (
      value.schemaVersion !== 1 ||
      value.runId !== runId ||
      value.sequence !== index + 1 ||
      value.previousHash !== head ||
      hashValue(content) !== hash
    )
      throw new Error("Event integrity verification failed");
    head = hash;
    last = value;
  }
  if (head !== expectedHead) throw new Error("Event head failed integrity verification");
  return last;
}

export async function verifySnapshot(directory: string, snapshot: SourceSnapshot): Promise<void> {
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    safeChild(directory, file.path);
    if (paths.has(file.path)) throw new Error("Duplicate source snapshot path");
    paths.add(file.path);
    const bytes = await readFile(join(directory, "objects", file.sha256));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error(`Source object failed integrity verification: ${file.path}`);
  }
}
