import { join } from "node:path";
import type { GraphConfig } from "../../config/schema.js";
import { HARD_IGNORED_DIRS, LIMITS } from "../../core/constants.js";
import { fromUnknown } from "../../core/errors.js";
import { type ProjectDirectoryEntry, ProjectFileSystem } from "../../core/fs.js";
import { matchesAny } from "../../core/patterns.js";
import { err, ok, type Result } from "../../core/result.js";
import type { FileEntry, SkippedFile, SkipReason, WalkResult } from "../types.js";
import { IgnoreStack } from "./ignore.js";
import { inspectFile } from "./scan.js";

const HARD_IGNORED = new Set<string>(HARD_IGNORED_DIRS);

interface WalkLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxWalkDepth: number;
}

/**
 * A contained walk: no symlink is followed, no ceiling is exceeded, and every
 * file left out appears in `skipped` with the reason it was left out.
 */
export async function walkRepository(
  root: string,
  config: GraphConfig,
): Promise<Result<WalkResult>> {
  const files = new ProjectFileSystem(root);
  const walk = new Walk(files.root, files, config.exclude, {
    maxFileBytes: config.maxFileBytes,
    maxFiles: LIMITS.maxFiles,
    maxWalkDepth: LIMITS.maxWalkDepth,
  });

  try {
    await walk.visit("", 0, IgnoreStack.empty());
  } catch (cause) {
    return err(fromUnknown(cause, "IO_ERROR"));
  }
  return ok(walk.result());
}

class Walk {
  private readonly files: FileEntry[] = [];
  private readonly skipped: SkippedFile[] = [];
  private capped = false;

  constructor(
    private readonly root: string,
    private readonly projectFiles: ProjectFileSystem,
    private readonly exclude: readonly string[],
    private readonly limits: WalkLimits,
  ) {}

  result(): WalkResult {
    return {
      files: [...this.files].sort((a, b) => compare(a.path, b.path)),
      skipped: [...this.skipped].sort(
        (a, b) => compare(a.path, b.path) || compare(a.reason, b.reason),
      ),
    };
  }

  async visit(repoDir: string, depth: number, inherited: IgnoreStack): Promise<void> {
    if (this.capped) return;

    const absoluteDir = repoDir === "" ? this.root : join(this.root, repoDir);
    const entries = await this.read(absoluteDir, repoDir);
    if (entries === undefined) return;

    const stack = await this.loadGitignore(repoDir, inherited);
    for (const entry of entries) {
      if (this.capped) return;
      await this.visitEntry(entry, repoDir, depth, stack);
    }
  }

  private async visitEntry(
    entry: ProjectDirectoryEntry,
    repoDir: string,
    depth: number,
    stack: IgnoreStack,
  ): Promise<void> {
    const repoPath = repoDir === "" ? entry.name : `${repoDir}/${entry.name}`;

    if (entry.type === "symlink") return this.skip(repoPath, "symlink");
    if (entry.type === "directory") return this.visitDirectory(entry, repoPath, depth, stack);
    if (entry.type !== "file") return;

    const reason = this.excluded(repoPath, false, stack);
    if (reason) return this.skip(repoPath, reason);
    await this.visitFile(repoPath);
  }

  private async visitDirectory(
    entry: ProjectDirectoryEntry,
    repoPath: string,
    depth: number,
    stack: IgnoreStack,
  ): Promise<void> {
    // Hard-ignored directories are a property of the tool, not of this repository.
    if (HARD_IGNORED.has(entry.name)) return;

    const reason = this.excluded(repoPath, true, stack);
    if (reason) return this.skip(repoPath, reason);
    if (depth + 1 > this.limits.maxWalkDepth) return this.skip(repoPath, "max_depth");
    await this.visit(repoPath, depth + 1, stack);
  }

  private async visitFile(repoPath: string): Promise<void> {
    if (this.files.length >= this.limits.maxFiles) {
      this.capped = true;
      return this.skip(repoPath, "max_files");
    }

    const absolute = join(this.root, repoPath);
    const metadata = await this.projectFiles.metadata(absolute);
    if (!metadata.ok || metadata.value?.type !== "file") {
      return this.skip(repoPath, "unreadable");
    }

    const inspection = await inspectFile(
      this.projectFiles,
      absolute,
      repoPath,
      metadata.value.size,
      this.limits.maxFileBytes,
    );
    if (inspection.kind === "skipped") return this.skip(repoPath, inspection.reason);
    this.files.push(inspection.entry);
  }

  private excluded(
    repoPath: string,
    isDirectory: boolean,
    stack: IgnoreStack,
  ): SkipReason | undefined {
    if (matchesAny(repoPath, this.exclude)) return "excluded";
    if (stack.ignores(repoPath, isDirectory)) return "gitignored";
    return undefined;
  }

  private skip(path: string, reason: SkipReason): void {
    this.skipped.push({ path, reason });
  }

  private async read(
    absoluteDir: string,
    repoDir: string,
  ): Promise<ProjectDirectoryEntry[] | undefined> {
    const metadata = await this.projectFiles.metadata(absoluteDir);
    if (!metadata.ok || metadata.value?.type !== "directory") {
      if (repoDir === "") {
        throw new Error(
          metadata.ok ? `Repository root is unavailable: ${absoluteDir}` : metadata.error.message,
        );
      }
      this.skip(repoDir, "unreadable");
      return undefined;
    }
    const entries = await this.projectFiles.listEntries(absoluteDir);
    if (!entries.ok) {
      if (repoDir === "") throw entries.error;
      this.skip(repoDir, "unreadable");
      return undefined;
    }
    return entries.value;
  }

  private async loadGitignore(repoDir: string, inherited: IgnoreStack): Promise<IgnoreStack> {
    const path = repoDir === "" ? ".gitignore" : `${repoDir}/.gitignore`;
    // Git does not follow .gitignore symlinks, and neither should a contained
    // repository walk. `metadata` applies the project boundary before the read.
    const metadata = await this.projectFiles.metadata(path);
    if (!metadata.ok || metadata.value?.type !== "file") return inherited;
    const content = await this.projectFiles.readText(path);
    return content.ok ? inherited.extend(repoDir, content.value) : inherited;
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
