import { constants } from "node:fs";
import {
  access,
  chmod as chmodPath,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename as renamePath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { STATE_DIR } from "./constants.js";
import { fromUnknown, isNodeError, type VispError, vispError } from "./errors.js";
import { canonicalProjectRoot, isInside, isPortableAbsolute } from "./paths.js";
import { err, ok, type Result } from "./result.js";

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<Result<void>> {
  try {
    await mkdir(path, { recursive: true });
    return ok(undefined);
  } catch (cause) {
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Refuses a symlink at this exact path, while allowing a missing path. */
export async function rejectSymlink(path: string): Promise<Result<void>> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return err(vispError("IO_ERROR", `Refusing to use symlink: ${path}`));
    }
    return ok(undefined);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Reads UTF-8 text, refusing symlinks so a link cannot redirect a read. */
export async function readText(path: string): Promise<Result<string>> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return err(vispError("IO_ERROR", `Refusing to read symlink: ${path}`));
    }
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return err(vispError("ARTIFACT_MISSING", `File not found: ${path}`));
    }
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Returns undefined when the file is absent; other failures still error. */
export async function readTextIfExists(path: string): Promise<Result<string | undefined>> {
  const result = await readText(path);
  if (result.ok) return result;
  return result.error.code === "ARTIFACT_MISSING" ? ok(undefined) : result;
}

/** Reads exact file bytes, refusing symlinks and distinguishing an absent file. */
export async function readBytesIfExists(path: string): Promise<Result<Uint8Array | undefined>> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      return err(vispError("IO_ERROR", `Refusing to read symlink: ${path}`));
    }
    return ok(await readFile(path));
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Writes via a temporary file and rename so readers never see a partial file. */
export async function writeTextAtomic(path: string, content: string): Promise<Result<void>> {
  const directory = dirname(path);
  const created = await ensureDir(directory);
  if (!created.ok) return created;

  const temporary = join(directory, `.${randomSuffix()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
    await renamePath(temporary, path);
    return ok(undefined);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

export async function readJson<T>(
  path: string,
  parse: (value: unknown) => Result<T>,
): Promise<Result<T>> {
  const text = await readText(path);
  if (!text.ok) return text;
  return parseJson(text.value, parse, path);
}

export async function readJsonIfExists<T>(
  path: string,
  parse: (value: unknown) => Result<T>,
): Promise<Result<T | undefined>> {
  const text = await readTextIfExists(path);
  if (!text.ok) return text;
  if (text.value === undefined) return ok(undefined);
  return parseJson(text.value, parse, path);
}

export async function writeJson(path: string, value: unknown): Promise<Result<void>> {
  return writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeFile(path: string): Promise<Result<void>> {
  try {
    await unlink(path);
    return ok(undefined);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Lists entry names in a directory; an absent directory yields an empty list. */
export async function listDir(path: string): Promise<Result<string[]>> {
  try {
    return ok((await readdir(path)).sort());
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

/** Lists sorted real subdirectories; files and symlinks are deliberately ignored. */
export async function listDirectories(path: string): Promise<Result<string[]>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return ok(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort(),
    );
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
    return err(fromUnknown(cause, "IO_ERROR"));
  }
}

function parseJson<T>(text: string, parse: (value: unknown) => Result<T>, path: string): Result<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return err(vispError("ARTIFACT_INVALID", `Malformed JSON in ${path}: ${describe(cause)}`));
  }
  return parse(raw);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export type { VispError };

export interface ProjectFileMetadata {
  readonly type: "file" | "directory" | "other";
  readonly mode: number;
  readonly size: number;
}

export interface ProjectDirectoryEntry {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

/**
 * Filesystem access constrained to one canonical project root.
 *
 * Node's path-based filesystem API cannot make the component check and the
 * operation one kernel-atomic step. We therefore validate before work and
 * immediately before each mutation, which closes accidental/link-redirection
 * failures while leaving only a concurrent local attacker race for a future
 * descriptor-relative implementation.
 */
export class ProjectFileSystem {
  readonly root: string;
  private readonly requestedRoot: string;

  constructor(root: string) {
    this.requestedRoot = resolve(root);
    this.root = canonicalProjectRoot(root);
  }

  async exists(path: string): Promise<Result<boolean>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      await access(target.value, constants.F_OK);
      return ok(true);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok(false);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async isDirectory(path: string): Promise<Result<boolean>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      return ok((await lstat(target.value)).isDirectory());
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok(false);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async ensureDir(path: string): Promise<Result<void>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      await mkdir(target.value, { recursive: true });
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
    const checked = await this.validate(target.value);
    return checked.ok ? ok(undefined) : checked;
  }

  async readText(path: string): Promise<Result<string>> {
    const bytes = await this.readBytes(path);
    return bytes.ok ? ok(Buffer.from(bytes.value).toString("utf8")) : bytes;
  }

  async readTextIfExists(path: string): Promise<Result<string | undefined>> {
    const bytes = await this.readBytesIfExists(path);
    if (!bytes.ok) return bytes;
    if (bytes.value === undefined) return ok(undefined);
    return ok(Buffer.from(bytes.value).toString("utf8"));
  }

  async readBytes(path: string): Promise<Result<Uint8Array>> {
    const target = await this.validateReadTarget(path);
    if (!target.ok) return target;
    try {
      return ok(await readFile(target.value));
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        return err(vispError("ARTIFACT_MISSING", `File not found: ${target.value}`));
      }
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async readBytesIfExists(path: string): Promise<Result<Uint8Array | undefined>> {
    const result = await this.readBytes(path);
    if (result.ok) return result;
    return result.error.code === "ARTIFACT_MISSING" ? ok(undefined) : result;
  }

  async readJson<T>(path: string, parse: (value: unknown) => Result<T>): Promise<Result<T>> {
    const text = await this.readText(path);
    if (!text.ok) return text;
    return parseJson(text.value, parse, this.displayPath(path));
  }

  async readJsonIfExists<T>(
    path: string,
    parse: (value: unknown) => Result<T>,
  ): Promise<Result<T | undefined>> {
    const text = await this.readTextIfExists(path);
    if (!text.ok) return text;
    if (text.value === undefined) return ok(undefined);
    return parseJson(text.value, parse, this.displayPath(path));
  }

  async writeTextAtomic(path: string, content: string, mode = 0o644): Promise<Result<void>> {
    return this.writeBytesAtomic(path, Buffer.from(content, "utf8"), mode);
  }

  async writeJson(path: string, value: unknown, mode = 0o644): Promise<Result<void>> {
    return this.writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode);
  }

  async writeBytesAtomic(path: string, content: Uint8Array, mode = 0o644): Promise<Result<void>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    const directory = dirname(target.value);
    const created = await this.ensureDir(directory);
    if (!created.ok) return created;

    const temporary = join(directory, `.${randomSuffix()}.tmp`);
    try {
      const ready = await this.validateMutationTarget(target.value);
      if (!ready.ok) return ready;
      await writeFile(temporary, content, { flag: "wx", mode });
      const stillSafe = await this.validateMutationTarget(target.value);
      if (!stillSafe.ok) return stillSafe;
      const safeTemporary = await this.validate(temporary);
      if (!safeTemporary.ok) return safeTemporary;
      await renamePath(safeTemporary.value, stillSafe.value);
      return ok(undefined);
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async removeFile(path: string): Promise<Result<void>> {
    const target = await this.validateMutationTarget(path);
    if (!target.ok) return target;
    try {
      await unlink(target.value);
      return ok(undefined);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  /** Removes one empty directory; recursive deletion is deliberately not exposed. */
  async removeDir(path: string): Promise<Result<void>> {
    const target = await this.validateMutationTarget(path);
    if (!target.ok) return target;
    if (target.value === this.root) {
      return err(vispError("IO_ERROR", "Refusing to remove the project root"));
    }
    try {
      await rmdir(target.value);
      return ok(undefined);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async rename(from: string, to: string): Promise<Result<void>> {
    const source = await this.validateMutationTarget(from);
    if (!source.ok) return source;
    const target = await this.validateMutationTarget(to);
    if (!target.ok) return target;
    if (source.value === this.root || target.value === this.root) {
      return err(vispError("IO_ERROR", "Refusing to rename the project root"));
    }
    try {
      const sourceReady = await this.validateMutationTarget(source.value);
      if (!sourceReady.ok) return sourceReady;
      const targetReady = await this.validateMutationTarget(target.value);
      if (!targetReady.ok) return targetReady;
      await renamePath(sourceReady.value, targetReady.value);
      return ok(undefined);
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async chmod(path: string, mode: number): Promise<Result<void>> {
    const target = await this.validateMutationTarget(path);
    if (!target.ok) return target;
    try {
      await chmodPath(target.value, mode);
      return ok(undefined);
    } catch (cause) {
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  /** Metadata for authored reads follows the same confined target as readBytes. */
  async readMetadata(path: string): Promise<Result<ProjectFileMetadata | undefined>> {
    const target = await this.validateReadTarget(path);
    return target.ok ? this.metadata(target.value) : target;
  }

  async metadata(path: string): Promise<Result<ProjectFileMetadata | undefined>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      const stats = await lstat(target.value);
      return ok({
        type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
        mode: stats.mode & 0o777,
        size: stats.size,
      });
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok(undefined);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async listDir(path: string): Promise<Result<string[]>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      return ok((await readdir(target.value)).sort());
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  async listDirectories(path: string): Promise<Result<string[]>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      const entries = await readdir(target.value, { withFileTypes: true });
      return ok(
        entries
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => entry.name)
          .sort(),
      );
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  /** Lists one contained directory without following any child symlink. */
  async listEntries(path: string): Promise<Result<ProjectDirectoryEntry[]>> {
    const target = await this.validate(path);
    if (!target.ok) return target;
    try {
      const entries = await readdir(target.value, { withFileTypes: true });
      return ok(
        entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isSymbolicLink()
              ? ("symlink" as const)
              : entry.isFile()
                ? ("file" as const)
                : entry.isDirectory()
                  ? ("directory" as const)
                  : ("other" as const),
          }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      );
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") return ok([]);
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  private async validateMutationTarget(path: string): Promise<Result<string>> {
    return this.validate(path);
  }

  /**
   * Authored repository files may use a symlink whose resolved target remains
   * inside this project. Machine state and every mutation stay on the stricter
   * component-by-component path. Reading the resolved target also avoids
   * following the caller-visible link a second time.
   */
  private async validateReadTarget(path: string): Promise<Result<string>> {
    const target = this.confinedTarget(path);
    if (!target.ok) return target;
    if (this.isManagedTarget(target.value)) return this.validate(target.value);

    try {
      const canonical = await realpath(target.value);
      if (!isInside(this.root, canonical) || this.isManagedTarget(canonical)) {
        return err(
          vispError("IO_ERROR", `Refusing project read through an external symlink: ${path}`),
        );
      }
      return this.validate(canonical);
    } catch (cause) {
      if (isNodeError(cause) && cause.code === "ENOENT") {
        // A genuinely absent file remains ARTIFACT_MISSING. A dangling symlink
        // (including one in a parent component) is rejected by strict validate.
        return this.validate(target.value);
      }
      return err(fromUnknown(cause, "IO_ERROR"));
    }
  }

  private isManagedTarget(path: string): boolean {
    const rel = relative(this.root, path).split(sep).join("/");
    return rel === STATE_DIR || rel.startsWith(`${STATE_DIR}/`);
  }

  private async validate(path: string): Promise<Result<string>> {
    const target = this.confinedTarget(path);
    if (!target.ok) return target;

    const rel = relative(this.root, target.value);
    if (rel === "") return ok(target.value);

    let current = this.root;
    const parts = rel.split(sep).filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index] ?? "");
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) {
          return err(
            vispError("IO_ERROR", `Refusing project path with symlink component: ${current}`),
          );
        }
        if (index < parts.length - 1 && !stats.isDirectory()) {
          return err(vispError("IO_ERROR", `Project path parent is not a directory: ${current}`));
        }
      } catch (cause) {
        if (isNodeError(cause) && cause.code === "ENOENT") break;
        return err(fromUnknown(cause, "IO_ERROR"));
      }
    }
    return ok(target.value);
  }

  private confinedTarget(path: string): Result<string> {
    if (hasParentSegment(path)) {
      return err(vispError("IO_ERROR", `Refusing path with parent traversal: ${path}`));
    }
    if (isPortableAbsolute(path) && !isAbsolute(path)) {
      return err(vispError("IO_ERROR", `Refusing portable absolute path: ${path}`));
    }
    let target: string;
    if (!isAbsolute(path)) {
      target = resolve(this.root, path);
    } else {
      const absolute = resolve(path);
      if (isInside(this.root, absolute)) {
        target = absolute;
      } else if (isInside(this.requestedRoot, absolute)) {
        target = resolve(this.root, relative(this.requestedRoot, absolute));
      } else {
        return err(vispError("IO_ERROR", `Refusing path outside project: ${path}`));
      }
    }

    return isInside(this.root, target)
      ? ok(target)
      : err(vispError("IO_ERROR", `Refusing path outside project: ${path}`));
  }

  private displayPath(path: string): string {
    const target = this.confinedTarget(path);
    return target.ok ? target.value : path;
  }
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}
