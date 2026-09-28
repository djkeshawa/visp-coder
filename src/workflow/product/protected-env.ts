import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";

const SKIP_DIRECTORIES = new Set([".git", ".visp", "node_modules", "dist", "build"]);

/** Hash ignored secret files without making their contents product evidence. */
export async function protectedEnvSnapshot(root: string): Promise<Result<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) await visit(absolute, path);
      } else if (/^\.env(?:\..*)?$/i.test(entry.name)) {
        const metadata = await lstat(absolute);
        if (metadata.isSymbolicLink()) snapshot[path] = `link:${await readlink(absolute)}`;
        else if (metadata.isFile()) {
          const digest = createHash("sha256");
          for await (const chunk of createReadStream(absolute)) digest.update(chunk);
          snapshot[path] = digest.digest("hex");
        }
      }
    }
  };
  try {
    await visit(root, "");
    return ok(snapshot);
  } catch (cause) {
    return err(
      vispError("COMMAND_FAILED", "Could not inspect protected environment files", {
        details: { cause: String(cause) },
      }),
    );
  }
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
