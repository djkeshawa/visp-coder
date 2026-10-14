import { copyFile, cp, mkdir, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { run } from "../../core/exec.js";
import { matchesPattern, normalizePath } from "../../core/patterns.js";
import { SECRET_FILES } from "../../core/redaction.js";
import { sweepAbandonedCredentialHomes, sweepStaleTempDirectories } from "../../core/stale-temp.js";
import type { WorkspaceState } from "../state.js";
import {
  CLAUDE_HOSTS,
  claudeSignedIn,
  reachesModel,
  runClaudeStructured,
  runCodexStructured,
} from "./critic-exec.js";
import { type IndependentTester, message, TESTER_TIMEOUT_MS } from "./independent-tests-model.js";

/**
 * Testers usually return in 1–3 minutes. These are polling budgets, not a bound on
 * the whole command; hosts should use their maximum shell timeout. `work` asks the
 * worker to run it again while the tester is still writing.
 */
const TESTS_WAIT_MS = { cli: 100_000, mcp: 50_000 } as const;

export function testsWaitMs(workspace: WorkspaceState, channel: "cli" | "mcp"): number {
  return testerCli(workspace) ? TESTS_WAIT_MS[channel] : 0;
}

/**
 * The CLI VISP launches the tester with, as for the reviewer: the critic's harness, or the
 * project's when the critic names none. Undefined when VISP launches no tester.
 */
export function testerCli(workspace: WorkspaceState): "codex" | "claude" | undefined {
  const { critic } = workspace.config;
  const harness = critic?.harness ?? workspace.config.harness;
  if (critic?.launch === "codex-exec" && harness === "codex") return "codex";
  if (critic?.launch === "claude-exec" && harness === "claude-code") return "claude";
  return undefined;
}

/** The tester session for this project's critic settings; undefined when VISP launches none. */
export function configuredTester(workspace: WorkspaceState): IndependentTester | undefined {
  const cli = testerCli(workspace);
  return cli === "claude" ? claudeTester() : cli === "codex" ? codexTester() : undefined;
}

export function codexTester(
  options: { executable?: string; lookup?: (host: string) => Promise<unknown> } = {},
): IndependentTester {
  return async (request) => {
    const { lookup: dnsLookup } = await import("node:dns/promises");
    if (!(await reachesModel(options.lookup ?? ((host) => dnsLookup(host)))))
      throw new Error("The tester cannot reach its model from this process");
    return testerSession(async (directory) => {
      const root = request.explore
        ? await repositoryCopy(
            request.root,
            directory,
            request.blockedPaths ?? [],
            request.sourceRoot,
          )
        : await emptyProject(directory);
      return runCodexStructured({
        ...(options.executable ? { executable: options.executable } : {}),
        root,
        ...(request.explore ? { sandbox: "workspace-write" as const, network: true } : {}),
        directory,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        schema: request.schema,
        prompt: request.prompt,
        signal: AbortSignal.timeout(TESTER_TIMEOUT_MS),
        ...(request.onActivity ? { onActivity: request.onActivity } : {}),
      });
    });
  };
}

/**
 * The tester as one `claude -p` session with the reviewer's restrictions (read-only tools,
 * no settings, hooks or MCP servers), confined to an empty temporary directory. It writes
 * tests for new projects only: running an existing program needs the Codex tester's
 * writable, networked sandbox.
 */
export function claudeTester(
  options: { executable?: string; lookup?: (host: string) => Promise<unknown> } = {},
): IndependentTester {
  return async (request) => {
    if (request.explore) throw new Error(CLAUDE_EXISTING_CODE);
    if (!(await claudeSignedIn(options.executable ?? "claude", AbortSignal.timeout(30_000))))
      throw new Error(
        "Claude Code is not signed in for this process (claude auth status); sign in with claude, then run visp work --feature <id> --retry-tests",
      );
    const { lookup: dnsLookup } = await import("node:dns/promises");
    if (!(await reachesModel(options.lookup ?? ((host) => dnsLookup(host)), CLAUDE_HOSTS)))
      throw new Error("The tester cannot reach its model from this process");
    return testerSession(async (directory) => {
      const root = await emptyProject(directory);
      return runClaudeStructured({
        ...(options.executable ? { executable: options.executable } : {}),
        root,
        directory: root,
        model: request.model,
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        schema: request.schema,
        prompt: request.prompt,
        signal: AbortSignal.timeout(TESTER_TIMEOUT_MS),
      });
    });
  };
}

export const CLAUDE_EXISTING_CODE =
  "The Claude tester writes tests for new projects only; tests of an existing codebase need critic.launch: codex-exec with critic.harness: codex";

/** One tester session in a fresh temporary directory, removed afterwards. */
async function testerSession(session: (directory: string) => Promise<unknown>): Promise<unknown> {
  await sweepStaleTempDirectories(STALE_TESTER_NAMES, STALE_TESTER_MS);
  await sweepAbandonedCredentialHomes();
  const directory = await mkdtemp(join(tmpdir(), "visp-tester-"));
  const started = Date.now();
  try {
    return await session(directory);
  } catch (cause) {
    // An abort here is the tester's own time limit; "The operation was aborted" hid that.
    if (Date.now() - started >= TESTER_TIMEOUT_MS)
      throw new Error(
        `The tester did not answer within ${TESTER_TIMEOUT_MS / 60_000} minutes (${message(cause)})`,
      );
    throw cause;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function emptyProject(directory: string): Promise<string> {
  const root = join(directory, "empty-project");
  await mkdir(root, { recursive: true });
  return root;
}

/** Exactly what `mkdtemp` makes (prefix plus six characters), so named directories survive. */
const STALE_TESTER_NAMES = [
  /^visp-tester-[A-Za-z0-9]{6}$/,
  // The launch-time source copy and each baseline run's copy (tester-snapshot.ts).
  /^visp-tester-(?:source|baseline)-[A-Za-z0-9]{6}$/,
  // The private HOME of one baseline run (runBaseline).
  /^visp-baseline-[A-Za-z0-9]{6}$/,
];

/** A tester is bounded by its deadline plus the baseline run; older copies are abandoned. */
const STALE_TESTER_MS = 2 * 60 * 60_000;

/** Like .gitignore: a pattern without a slash matches a name at any depth. */
function leftOut(path: string, patterns: readonly string[]): boolean {
  const parts = path.split("/");
  return patterns.some((pattern) =>
    parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      return (
        matchesPattern(prefix, pattern) ||
        (!pattern.includes("/") && matchesPattern(basename(prefix), pattern))
      );
    }),
  );
}

/**
 * A disposable copy of the tracked and untracked project files, without VISP state, blocked
 * paths or secret files, where the tester may run the existing program with network. The
 * real project is never written.
 */
async function repositoryCopy(
  root: string,
  directory: string,
  blockedPaths: readonly string[],
  sourceRoot?: string,
): Promise<string> {
  const copy = join(directory, "repository");
  if (sourceRoot) {
    await cp(sourceRoot, copy, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (path) => {
        const local = normalizePath(relative(sourceRoot, path));
        const link = await readlink(path).catch(() => undefined);
        const target =
          link === undefined
            ? local
            : normalizePath(relative(sourceRoot, resolve(dirname(path), link)));
        return ![local, target].some((entry) =>
          leftOut(entry, [".git", ".visp", "acceptance", ...SECRET_FILES, ...blockedPaths]),
        );
      },
    });
    return copy;
  }
  const listed = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    timeoutMs: 20_000,
  });
  const files = listed.ok ? listed.value.stdout.split("\0").filter(Boolean) : [];
  const excluded = [...SECRET_FILES, ...blockedPaths];
  for (const path of files) {
    if (path.startsWith(".visp/") || path.startsWith("acceptance/")) continue;
    if (leftOut(path, excluded)) continue;
    await mkdir(dirname(join(copy, path)), { recursive: true });
    await copyFile(join(root, path), join(copy, path)).catch(() => undefined);
  }
  return copy;
}
