import { type ChildProcess, spawn } from "node:child_process";
import { LIMITS } from "./constants.js";
import { fromUnknown } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { prepareCommand } from "./windows-command.js";

export interface CommandOutput {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted?: boolean;
  readonly durationMs: number;
}

export interface RunOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: Record<string, string>;
  /** Use exactly the supplied environment instead of extending the caller's. */
  readonly replaceEnv?: boolean;
}

/** Runs argv without a shell; owns the process group and bounds retained output. */
export function run(
  file: string,
  args: readonly string[],
  options: RunOptions,
): Promise<Result<CommandOutput>> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? LIMITS.commandTimeoutMs;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      options.signal?.throwIfAborted();
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Invalid command timeout");
      const env = options.replaceEnv ? (options.env ?? {}) : { ...process.env, ...options.env };
      const prepared = prepareCommand(file, args, env);
      child = spawn(prepared.file, prepared.args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        env,
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      });
    } catch (cause) {
      resolve(err(fromUnknown(cause, "COMMAND_FAILED")));
      return;
    }
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let timedOut = false;
    let aborted = false;
    let finished = false;
    let exitCode = 1;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : undefined;
    const finish = (failure?: Error & { code?: string }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      options.signal?.removeEventListener("abort", cancel);
      killCommandGroup(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failure) {
        const error = fromUnknown(failure, "COMMAND_FAILED");
        resolve(err({ ...error, details: { ...error.details, errno: failure.code } }));
      } else
        resolve(
          ok({
            command: [file, ...args].join(" "),
            exitCode: timedOut || aborted ? 1 : exitCode,
            stdout: stdout.text(),
            stderr: stderr.text(),
            timedOut,
            aborted,
            durationMs: Date.now() - started,
          }),
        );
    };
    const stop = () => {
      killCommandGroup(child, "SIGTERM");
      grace ??= setTimeout(() => finish(), 200);
    };
    const cancel = () => {
      aborted = true;
      stop();
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("error", finish);
    child.once("exit", (code) => {
      exitCode = code ?? 1;
      clearTimeout(timer);
      // A descendant may retain stdout after its parent exits. Drain briefly, then reap it.
      stop();
    });
    child.once("close", () => finish());
    if (options.input !== undefined) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
}

/** Signals a spawned command's whole process group (its tree on Windows). */
export function killCommandGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") killWindowsTree(child, signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* The process group has already exited. */
  }
}

/**
 * Windows has no process groups: `child.kill()` ends only the shim (cmd.exe, npm.cmd) and
 * leaves the real command running. taskkill /T walks the tree while its root is alive; after
 * the root exited its pid may belong to someone else, so nothing is killed then.
 */
function killWindowsTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // taskkill failing to start, or exiting non-zero while the root still runs, leaves the shim
  // killable at least.
  const fallback = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  try {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", fallback);
    killer.once("exit", (code) => {
      if (code !== 0) fallback();
    });
  } catch {
    fallback();
  }
}

class BoundedOutput {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private total = 0;
  private readonly half = 4 * 1024 * 1024;

  add(chunk: Buffer) {
    this.total += chunk.length;
    const keep = Math.min(this.half - this.headBytes, chunk.length);
    if (keep > 0) {
      this.head.push(chunk.subarray(0, keep));
      this.headBytes += keep;
    }
    if (keep === chunk.length) return;
    this.tail.push(chunk.subarray(keep));
    this.tailBytes += chunk.length - keep;
    while (this.tailBytes > this.half) {
      const first = this.tail[0];
      if (!first) break;
      const excess = this.tailBytes - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
      }
    }
  }

  text() {
    return Buffer.concat([
      ...this.head,
      ...(this.total > this.half * 2 ? [Buffer.from("\n[VISP: output truncated]\n")] : []),
      ...this.tail,
    ]).toString("utf8");
  }
}

/**
 * Splits a shell-style command string into an argv vector for {@link run}.
 * Only plain words and quoted segments are supported; anything containing shell
 * metacharacters is rejected rather than passed to a shell.
 */
export function parseCommand(input: string): Result<string[], ShellSyntaxError> {
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
    } else if (/[|&;<>$`(){}[\]!*?~]/.test(character)) {
      return {
        ok: false,
        error: {
          kind: "shell-syntax",
          message: `Command contains shell syntax (${character}) and cannot run without a shell: ${input}`,
        },
      };
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
