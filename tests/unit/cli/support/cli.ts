import type { Command } from "commander";
import type { Envelope } from "../../../../src/cli/output.js";

/**
 * Runs a real `visp` command in process against a `TestWorkspace`.
 *
 * Functional tests spawn the built binary, which is the right way to check what
 * a user runs but produces no coverage and costs a process per case. The
 * commands themselves are ordinary functions over a workspace root, so they can
 * be driven directly — which is the only way to reach the branches that only
 * happen when something is wrong, and the only way anything measures them.
 */

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface JsonResult<T> extends CliResult {
  readonly envelope: Envelope<T>;
}

export async function runCli(root: string, ...args: string[]): Promise<CliResult> {
  const program = (await buildProgram())();
  refuseToExitTheTestRun(program);

  const stdout: string[] = [];
  const stderr: string[] = [];
  const restoreStreams = captureStreams(stdout, stderr);

  // Commands signal failure by setting `process.exitCode` rather than throwing,
  // so the value has to be read and put back here. Left in place it would both
  // leak into the next case — a refusal making the following success look like
  // one too — and mark the whole vitest run as failed on the way out.
  const outerExitCode = process.exitCode;
  process.exitCode = undefined;

  let exitCode: number;
  try {
    try {
      await program.parseAsync(["node", "visp", "--project", root, ...args]);
      exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    } catch (cause) {
      const commanderCode = commanderExitCode(cause);
      if (commanderCode === undefined) throw cause;
      exitCode = commanderCode;
    }
  } finally {
    restoreStreams();
    process.exitCode = outerExitCode;
  }

  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

/** Runs with `--json` and parses the one envelope the command printed. */
export async function runJson<T>(root: string, ...args: string[]): Promise<JsonResult<T>> {
  const result = await runCli(root, ...args, "--json");

  let envelope: Envelope<T>;
  try {
    envelope = JSON.parse(result.stdout) as Envelope<T>;
  } catch {
    throw new Error(`not a json envelope: ${JSON.stringify(result.stdout)}${result.stderr}`);
  }

  return { ...result, envelope };
}

/** Names the top-level command surface without executing a command. */
export async function registeredCommands(): Promise<string[]> {
  return (await buildProgram())()
    .commands.map((command) => command.name())
    .sort();
}

let cached: (() => Command) | undefined;

/**
 * Loads `buildProgram` without tripping the entrypoint guard at the bottom of
 * `main.ts`, which runs the whole CLI when `process.argv[1]` contains "cli".
 * Under vitest that argument is the worker's entry path, which carries the
 * checkout's own location in it — so a repository cloned into a directory whose
 * name contains those three letters would run `visp` against vitest's arguments
 * at import time, and every case here would fail somewhere far from the cause.
 */
async function buildProgram(): Promise<() => Command> {
  if (cached) return cached;

  const entrypoint = process.argv[1];
  process.argv[1] = "";
  try {
    const main = await import("../../../../src/cli/main.js");
    cached = main.buildProgram;
  } finally {
    if (entrypoint === undefined) process.argv.length = 1;
    else process.argv[1] = entrypoint;
  }

  return cached;
}

/**
 * Commander calls `process.exit` on a usage error, which in a test process kills
 * the run instead of failing the assertion. Every command carries its own
 * settings, so the override has to be applied down the whole tree.
 */
function refuseToExitTheTestRun(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) refuseToExitTheTestRun(child);
}

function commanderExitCode(cause: unknown): number | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const candidate = cause as { code?: unknown; exitCode?: unknown };
  if (typeof candidate.code !== "string" || !candidate.code.startsWith("commander.")) {
    return undefined;
  }
  return typeof candidate.exitCode === "number" ? candidate.exitCode : 1;
}

function captureStreams(stdout: string[], stderr: string[]): () => void {
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;

  process.stdout.write = intercept(stdout);
  process.stderr.write = intercept(stderr);

  return () => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  };
}

function intercept(sink: string[]): typeof process.stdout.write {
  return ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    sink.push(typeof chunk === "string" ? chunk : String(chunk));

    // `write(chunk, cb)` and `write(chunk, encoding, cb)` are both legal; a
    // caller that passed one is entitled to have it run.
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as typeof process.stdout.write;
}
