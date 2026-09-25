import { vispError } from "../core/errors.js";
import { type ProjectFileMetadata, ProjectFileSystem } from "../core/fs.js";
import { hashValue, sha256 } from "../core/hash.js";
import { err, ok, type Result } from "../core/result.js";

interface HistoryFile {
  path: string;
  mode: number;
  sha256: string;
  bytes: number;
  contentBase64: string;
}
const excluded = [
  ".visp/exports",
  ".visp/migrations/backups",
  ".visp/state/mutation.lock",
  ".visp/state/mutation.lock.recovery",
];
const limits = {
  files: 10000,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  depth: 64,
};

/** Raw preservation deliberately does not load configuration or parse historical records. */
export async function collectMigrationHistory(root: string) {
  const fs = new ProjectFileSystem(root);
  const files: HistoryFile[] = [];
  let total = 0;
  let visited = 0;
  async function collect(path: string, depth: number): Promise<Result<void>> {
    if (excluded.includes(path)) return ok(undefined);
    if (++visited > limits.files) return invalid("History exceeds export entry limit");
    if (depth > limits.depth) return invalid("History exceeds export depth limit");
    const metadata = await fs.metadata(path);
    if (!metadata.ok) return metadata;
    if (!metadata.value) return ok(undefined);
    return metadata.value.type === "directory"
      ? collectDirectory(path, depth)
      : collectFile(path, metadata.value);
  }
  async function collectDirectory(path: string, depth: number): Promise<Result<void>> {
    const entries = await fs.listEntries(path);
    if (!entries.ok) return entries;
    for (const entry of entries.value) {
      if (entry.type === "symlink" || entry.type === "other")
        return invalid(`Cannot export non-regular history: ${path}/${entry.name}`);
      const result = await collect(`${path}/${entry.name}`, depth + 1);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
  async function collectFile(path: string, metadata: ProjectFileMetadata): Promise<Result<void>> {
    if (metadata.type !== "file") return invalid(`Cannot export non-file history: ${path}`);
    if (
      files.length >= limits.files ||
      metadata.size > limits.fileBytes ||
      total + metadata.size > limits.totalBytes
    )
      return invalid("History exceeds export size limits; no partial export was created");
    const bytes = await fs.readBytes(path);
    if (!bytes.ok) return bytes;
    if (bytes.value.length !== metadata.size)
      return invalid(`History changed while reading ${path}; retry when writers are idle`);
    total += bytes.value.length;
    files.push({
      path,
      mode: metadata.mode,
      sha256: sha256(bytes.value),
      bytes: bytes.value.length,
      contentBase64: Buffer.from(bytes.value).toString("base64"),
    });
    return ok(undefined);
  }
  const roots = ["visp.yml", ".gitignore", ".visp"];
  for (const path of roots) {
    const result = await collect(path, 0);
    if (!result.ok) return result;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const snapshot = {
    version: 1 as const,
    kind: "visp-migration-history" as const,
    roots,
    excluded,
    files,
  };
  return ok({ ...snapshot, digest: hashValue(snapshot), bytes: total });
}
function invalid(message: string) {
  return err(vispError("ARTIFACT_INVALID", message));
}
