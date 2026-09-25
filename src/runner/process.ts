import { execFile, spawn } from "node:child_process";
import { devNull } from "node:os";

export function executionEnvironment(host = false): NodeJS.ProcessEnv {
  const names = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];
  if (host) names.push("HOME", "USERPROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR");
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

export function execute(
  file: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
  env: NodeJS.ProcessEnv = executionEnvironment(),
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(`${file} exited unsuccessfully: ${stderr.slice(0, 1000) || error.message}`),
          );
        else resolve(stdout);
      },
    );
  });
}

export function git(cwd: string, args: readonly string[]): Promise<string> {
  return execute(
    "git",
    [
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    cwd,
    30_000,
    {
      ...executionEnvironment(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  );
}

export type StopReason =
  | "exited"
  | "cancelled"
  | "timed-out"
  | "budget-exceeded"
  | "protocol-error"
  | "output-limit";
export interface StreamResult {
  readonly exitCode: number | null;
  readonly reason: StopReason;
  readonly stderr: string;
  readonly error?: string;
}
export interface StreamOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onLine: (line: string) => "budget-exceeded" | undefined;
}

/** Bounds output and kills the process group on POSIX; no shell or ambient credential variables. */
export function executeStream(options: StreamOptions): Promise<StreamResult> {
  return new Promise((resolve) => {
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: executionEnvironment(true),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let reason: StopReason = "exited";
    let error: string | undefined;
    let pending = "";
    let stderr = "";
    let size = 0;
    let force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may have exited between output and termination. */
      }
    };
    const stop = (value: StopReason): void => {
      if (reason !== "exited") return;
      reason = value;
      kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 1000);
      force.unref();
    };
    const consume = (line: string): void => {
      if (!line.trim() || reason !== "exited") return;
      try {
        const requested = options.onLine(line);
        if (requested) stop(requested);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        stop("protocol-error");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 16 * 1024 * 1024) return stop("output-limit");
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 2 * 1024 * 1024) stop("output-limit");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.on("error", (cause) => {
      error = cause.message;
      reason = "protocol-error";
    });
    child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE") {
        error = cause.message;
        stop("protocol-error");
      }
    });
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timed-out"), options.timeoutMs);
    if (options.signal?.aborted) abort();
    child.on("close", (exitCode) => {
      consume(pending);
      kill("SIGKILL");
      clearTimeout(timer);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode, reason, stderr, error });
    });
    child.stdin.end(options.input);
  });
}
