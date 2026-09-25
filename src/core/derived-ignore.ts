import { DERIVED_STATE_PATHS, LEGACY_STATE_IGNORE } from "./constants.js";
import { type FileMutation, filePrecondition } from "./file-transaction.js";
import type { ProjectFileSystem } from "./fs.js";
import { ok, type Result } from "./result.js";

/** Read-only planning shared by initialization and explicit workflow migration. */
export async function planDerivedStateIgnore(
  files: ProjectFileSystem,
  root: string,
): Promise<Result<FileMutation | undefined>> {
  const path = `${root}/.gitignore`;
  const current = await files.readTextIfExists(path);
  if (!current.ok) return current;
  const content = current.value ?? "";
  const present = new Set(content.split("\n").map((line) => line.trim()));

  // A blanket ignore is an explicit project choice; never rewrite it here.
  if (present.has(LEGACY_STATE_IGNORE)) return ok(undefined);
  const missing = DERIVED_STATE_PATHS.filter((entry) => !present.has(entry));
  if (missing.length === 0) return ok(undefined);
  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  return ok({
    kind: "write",
    path,
    content: `${content}${separator}${missing.join("\n")}\n`,
    expectedBefore: filePrecondition(current.value),
  });
}
