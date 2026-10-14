import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";

const SKIP_DIRECTORIES = new Set([".git", ".visp", "node_modules", "dist", "build"]);
const ENV_FILE = /^\.env(?:\..*)?$/i;

/**
 * Hash ignored secret files without making their contents product evidence. `done` and Git's
 * pre-commit guard read this on every call, and it is most of their file system work on a
 * large tree, so directories are read concurrently: a 20,000-file ignored virtualenv took
 * 91 ms one directory at a time and 28 ms this way. The files found are hashed one at a time
 * afterwards, so a tree with many of them never holds more than one open. The result is
 * sorted by path.
 */
export async function protectedEnvSnapshot(root: string): Promise<Result<Record<string, string>>> {
  const found: [string, string][] = [];
  try {
    for (const [path, absolute] of (await environmentFiles(root, "")).sort(([left], [right]) =>
      left < right ? -1 : 1,
    )) {
      const digest = await fileDigest(absolute);
      if (digest !== undefined) found.push([path, digest]);
    }
  } catch (cause) {
    return err(
      vispError("COMMAND_FAILED", "Could not inspect protected environment files", {
        details: { cause: String(cause) },
      }),
    );
  }
  return ok(Object.fromEntries(found));
}

/** Every environment file under `directory`, as [project path, absolute path]. */
async function environmentFiles(directory: string, relative: string): Promise<[string, string][]> {
  const found: [string, string][] = [];
  const nested: Promise<[string, string][]>[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const isDirectory = entry.isDirectory();
    if (isDirectory ? SKIP_DIRECTORIES.has(entry.name.toLowerCase()) : !ENV_FILE.test(entry.name))
      continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (isDirectory) nested.push(environmentFiles(absolute, path));
    else found.push([path, absolute]);
  }
  for (const files of await Promise.all(nested)) found.push(...files);
  return found;
}

/** A link is recorded by its target, a file by its content hash; anything else is skipped. */
async function fileDigest(path: string): Promise<string | undefined> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) return `link:${await readlink(path)}`;
  if (!metadata.isFile()) return undefined;
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function changedProtectedEnvFiles(
  root: string,
  baseline: Readonly<Record<string, string>>,
): Promise<Result<string[]>> {
  const current = await protectedEnvSnapshot(root);
  if (!current.ok) return current;
  return ok(
    [...new Set([...Object.keys(current.value), ...Object.keys(baseline)])].filter(
      (path) => current.value[path] !== baseline[path],
    ),
  );
}
