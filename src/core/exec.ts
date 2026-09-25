import { execFile } from "node:child_process";
import { LIMITS } from "./constants.js";
import { fromUnknown } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface CommandOutput {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
  /** Use exactly the supplied environment instead of extending the caller's. */
  readonly replaceEnv?: boolean;
}

/**
 * Runs a command as an argv vector. There is no shell, so nothing in a command
 * string can be interpolated into one.
 */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Result<CommandOutput>> {
  const started = Date.now();
  const timeout = options.timeoutMs ?? LIMITS.commandTimeoutMs;

  return new Promise((resolvePromise) => {
    try {
      execFile(
        file,
        [...args],
        {
          cwd: options.cwd,
          timeout,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          env: options.replaceEnv
            ? (options.env ?? {})
            : options.env
              ? { ...process.env, ...options.env }
              : process.env,
        },
        (error, stdout, stderr) => {
          resolvePromise(
            commandResult(error, stdout, stderr, [file, ...args].join(" "), Date.now() - started),
          );
        },
      );
    } catch (cause) {
      resolvePromise(err(fromUnknown(cause, "COMMAND_FAILED")));
    }
  });
}

type ProcessError = Error & {
  readonly code?: string | number | null;
  readonly killed?: boolean;
  readonly signal?: string;
};

function commandResult(
  error: ProcessError | null,
  stdout: string,
  stderr: string,
  command: string,
  durationMs: number,
): Result<CommandOutput> {
  // A process that exited carries a numeric `code`. A spawn that never
  // happened carries an errno string — those are not a failing check, they are
  // no check, and must not be reported as a test failure.
  if (isSpawnFailure(error)) {
    const failure = fromUnknown(error, "COMMAND_FAILED");
    return { ok: false, error: { ...failure, details: { ...failure.details, errno: error.code } } };
  }

  return ok({
    command,
    exitCode: exitCodeOf(error),
    stdout,
    stderr,
    timedOut: timedOut(error),
    durationMs,
  });
}

function isSpawnFailure(error: ProcessError | null): error is ProcessError {
  return error !== null && (!("code" in error) || typeof error.code === "string");
}

function exitCodeOf(error: ProcessError | null): number {
  if (typeof error?.code === "number") return error.code;
  return error ? 1 : 0;
}

function timedOut(error: ProcessError | null): boolean {
  if (!error?.killed) return false;
  // `killed` is true for any signal, not just ours. Calling a SIGINT a timeout
  // would put a wrong reason in the evidence record.
  return error.signal === "SIGTERM" || error.signal === undefined;
}

/**
 * Splits a shell-style command string into an argv vector for {@link run}.
 * Only plain words and quoted segments are supported; anything containing shell
 * metacharacters is rejected rather than passed to a shell.
 */
export function parseCommand(input: string): Result<string[], ShellSyntaxError> {
  const metacharacter = /[|&;<>$`\\(){}[\]!*?~\n]/.exec(input);
  if (metacharacter) {
    return {
      ok: false,
      error: {
        kind: "shell-syntax",
        message: `Command contains shell syntax (${metacharacter[0]}) and cannot run without a shell: ${input}`,
      },
    };
  }
  return splitCommandWords(input);
}

function splitCommandWords(input: string): Result<string[], ShellSyntaxError> {
  const argv: string[] = [];
  let word = "";
  let quote: string | undefined;
  let started = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) argv.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) {
    return {
      ok: false,
      error: { kind: "shell-syntax", message: "Command has an unterminated quote" },
    };
  }
  if (started) argv.push(word);
  return resolveCommand(argv);
}

/**
 * A command as written: a string to split, or an argv vector given directly.
 *
 * The array form exists because there is no shell. `pnpm test && pnpm lint` has
 * no argv, and neither does `CI=1 pytest` — the answer to those is two entries,
 * not a shell. What the array does solve is the argument that only *looks* like
 * shell syntax, such as `["pnpm", "test", "--", "--reporter=dot"]`.
 */
export type CommandSpec = string | readonly string[];

/** The argv to run, or why this spec cannot produce one. */
export function resolveCommand(spec: CommandSpec): Result<string[], ShellSyntaxError> {
  if (typeof spec === "string") return parseCommand(spec);

  if (spec.length === 0 || spec[0] === "") {
    return { ok: false, error: { kind: "shell-syntax", message: "Command is empty" } };
  }
  return ok([...spec]);
}

/** How a spec is shown to a human, and recorded in evidence. */
export function describeCommand(spec: CommandSpec): string {
  return typeof spec === "string"
    ? spec
    : spec
        .map((argument) =>
          argument === "" || /[\s"']/.test(argument) ? JSON.stringify(argument) : argument,
        )
        .join(" ");
}

export interface ShellSyntaxError {
  readonly kind: "shell-syntax";
  readonly message: string;
}
