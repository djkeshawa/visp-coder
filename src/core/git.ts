import { type VispError, vispError } from "./errors.js";
import { run } from "./exec.js";
import { err, ok, type Result } from "./result.js";

export interface ChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

/** How a set of changed files was determined. Recorded alongside evidence. */
export type DiffBasis = "working-tree" | "staged" | "ref";

export interface DiffResult {
  readonly basis: DiffBasis;
  readonly files: readonly ChangedFile[];
  readonly reference?: string;
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export async function isRepository(cwd: string): Promise<boolean> {
  const result = await run("git", ["rev-parse", "--git-dir"], { cwd, env: GIT_ENV });
  return result.ok && result.value.exitCode === 0;
}

/**
 * One fail-closed response for setup and workflow commands that need Git.
 * The structured flags keep weak or scripted callers from treating refusal
 * prose as a warning and continuing to edit.
 */
export function repositoryRequiredError(gitMetadataPresent?: boolean): VispError {
  const unusableMetadata = gitMetadataPresent === true;
  const cause = unusableMetadata
    ? "a .git path exists, but Git cannot use it as a repository"
    : "this workspace is not a usable Git repository";

  return vispError(
    "STAGE_BLOCKED",
    `The Visp workflow is blocked because ${cause}. Stop before editing: do not suppress this failure or continue feature work. Initialize or repair Git, complete Visp setup, then restart the coding agent so project instructions load at startup.`,
    {
      recovery: unusableMetadata
        ? "Repair the unusable .git metadata, then rerun visp init --harness <name>"
        : "git init",
      details: {
        blocker: "repository",
        mayEdit: false,
        restartAgentAfterSetup: true,
        suppressFailure: false,
        ...(gitMetadataPresent === undefined ? {} : { gitMetadataPresent }),
      },
    },
  );
}

/** Whether anything is tracked at all — an empty repository has nothing to index. */
export async function hasTrackedFiles(cwd: string): Promise<boolean> {
  const result = await run("git", ["ls-files", "-z"], { cwd, env: GIT_ENV });
  return result.ok && result.value.exitCode === 0 && result.value.stdout.trim() !== "";
}

/** Repository-relative tracked paths, sorted by git. */
export async function trackedFiles(cwd: string): Promise<Result<string[]>> {
  const result = await run("git", ["ls-files", "-z"], { cwd, env: GIT_ENV });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(vispError("COMMAND_FAILED", "Could not list tracked repository files"));
  }
  return ok(result.value.stdout.split("\0").filter(Boolean));
}

/**
 * Repository-relative files currently present for coding work.
 *
 * Context selection needs newly created files before their first commit. Plain
 * `git ls-files` omits exactly those files, which left greenfield tasks reading
 * a repository snapshot that could not contain their own output.
 */
export async function repositoryFiles(cwd: string): Promise<Result<string[]>> {
  const result = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd,
      env: GIT_ENV,
    },
  );
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(vispError("COMMAND_FAILED", "Could not list repository files"));
  }
  return ok(result.value.stdout.split("\0").filter(Boolean).sort());
}

/** Gitlinks are directory entries, including when their checkout is not initialized. */
export async function repositoryGitlinks(cwd: string): Promise<Result<string[]>> {
  const result = await run("git", ["ls-files", "--stage", "-z"], { cwd, env: GIT_ENV });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0)
    return err(vispError("COMMAND_FAILED", "Could not inspect repository entry modes"));
  return ok(
    result.value.stdout.split("\0").flatMap((entry) => {
      const match = /^160000 [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(entry);
      return match?.[1] ? [match[1]] : [];
    }),
  );
}

export async function currentBranch(cwd: string): Promise<Result<string>> {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    env: GIT_ENV,
  });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(vispError("COMMAND_FAILED", "Could not read the current git branch"));
  }
  return ok(result.value.stdout.trim());
}

export async function headCommit(cwd: string): Promise<Result<string>> {
  const result = await run("git", ["rev-parse", "HEAD"], { cwd, env: GIT_ENV });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(vispError("COMMAND_FAILED", "Repository has no commits yet"));
  }
  return ok(result.value.stdout.trim());
}

/** Files changed in the working tree, including untracked files. */
export async function workingTreeChanges(cwd: string): Promise<Result<DiffResult>> {
  const result = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    env: GIT_ENV,
  });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(
      vispError("COMMAND_FAILED", "git status failed", {
        details: { stderr: result.value.stderr },
      }),
    );
  }
  return ok({ basis: "working-tree", files: parsePorcelain(result.value.stdout) });
}

export async function stagedChanges(cwd: string): Promise<Result<DiffResult>> {
  const result = await run("git", ["diff", "--cached", "--name-status", "-z"], {
    cwd,
    env: GIT_ENV,
  });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(vispError("COMMAND_FAILED", "git diff --cached failed"));
  }
  return ok({ basis: "staged", files: parseNameStatus(result.value.stdout) });
}

export async function changesSince(cwd: string, reference: string): Promise<Result<DiffResult>> {
  const result = await run("git", ["diff", "--name-status", "-z", `${reference}...HEAD`, "--"], {
    cwd,
    env: GIT_ENV,
  });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(
      vispError("COMMAND_FAILED", `Could not diff against ${reference}`, {
        recovery: "Check that the reference exists: git rev-parse <ref>",
      }),
    );
  }
  return ok({ basis: "ref", reference, files: parseNameStatus(result.value.stdout) });
}

export async function createBranch(cwd: string, name: string): Promise<Result<void>> {
  const result = await run("git", ["checkout", "-b", name], { cwd, env: GIT_ENV });
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) {
    return err(
      vispError("COMMAND_FAILED", `Could not create branch ${name}`, {
        details: { stderr: result.value.stderr.trim() },
      }),
    );
  }
  return ok(undefined);
}

function parsePorcelain(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    // Porcelain -z puts the destination first, followed by the original path.
    if (code.includes("R") || code.includes("C")) {
      const source = records[++index];
      if (source && code.includes("R")) files.push({ path: source, status: "deleted" });
    }
    files.push({ path, status: porcelainStatus(code) });
  }
  return dedupe(files);
}

function parseNameStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const code = records[index] ?? "";
    if (code === "") continue;
    const source = records[++index];
    if (!source) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const destination = records[++index];
      if (!destination) continue;
      files.push(...relocatedFiles(code, source, destination));
    } else {
      files.push({ path: source, status: nameStatus(code) });
    }
  }
  return dedupe(files);
}

function relocatedFiles(code: string, source: string, destination: string): ChangedFile[] {
  // Renaming also removes the old path: every scope consumer must see it.
  return code.startsWith("R")
    ? [
        { path: source, status: "deleted" },
        { path: destination, status: "renamed" },
      ]
    : [{ path: destination, status: "added" }];
}

function porcelainStatus(code: string): ChangedFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  return "modified";
}

function nameStatus(code: string): ChangedFile["status"] {
  const letter = code.charAt(0);
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  return "modified";
}

function dedupe(files: ChangedFile[]): ChangedFile[] {
  const seen = new Map<string, ChangedFile>();
  for (const file of files) seen.set(file.path, file);
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
