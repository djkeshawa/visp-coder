import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productExecutionEnvironment } from "../core/execution-environment.js";
import { bounded } from "./deadline.js";

export class BrowserUnavailableError extends Error {}
/** An established browser failed to execute an operation; partial history remains diagnostic. */
export class BrowserRuntimeError extends Error {
  constructor(
    message: string,
    readonly status: "failed" | "timed-out" = "failed",
  ) {
    super(message);
  }
}

export interface ChromeTransport {
  onEvent(
    listener: (event: {
      method: string;
      params: Record<string, unknown>;
      sessionId?: string;
    }) => void,
  ): () => void;
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** New process and profile only. No browser download, user session, or sandbox-disabling flag. */
export async function launchChrome(
  options: { binary?: string; startupTimeoutMs?: number; operationTimeoutMs?: number } = {},
): Promise<ChromeTransport> {
  const profile = await mkdtemp(join(tmpdir(), "visp-browser-"));
  const binary = options.binary ?? process.env.CHROME_BIN ?? "google-chrome";
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--no-first-run",
      "--disable-extensions",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], env: productExecutionEnvironment() },
  );
  let stderr = "";
  let diagnosticTruncated = false;
  const captureDiagnostic = (chunk: Buffer) => {
    const combined = stderr + String(chunk);
    diagnosticTruncated ||= combined.length > 8_192;
    stderr = combined.slice(-8_192);
  };
  child.stderr?.on("data", captureDiagnostic);
  let connection: ChromeTransport | undefined;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await connection?.close();
      await stopChild(child);
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    }
  }
  try {
    const endpoint = await debuggingEndpoint(child, options.startupTimeoutMs ?? 10_000);
    connection = await connect(
      endpoint,
      options.startupTimeoutMs ?? 10_000,
      options.operationTimeoutMs ?? 5_000,
    );
    return { send: connection.send, onEvent: connection.onEvent, close };
  } catch (cause) {
    await close();
    throw startupError(binary, cause, stderr, diagnosticTruncated);
  } finally {
    child.stderr?.removeListener("data", captureDiagnostic);
  }
}

function startupError(
  binary: string,
  cause: unknown,
  stderr: string,
  diagnosticTruncated: boolean,
): BrowserUnavailableError {
  const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";
  const recovery = missing
    ? "Select an installed Chrome/Chromium executable with --binary or CHROME_BIN."
    : "Inspect the startup diagnostic and host process permissions. If the host restricts execution, use its supported permission recovery; keep browser sandboxing enabled.";
  return new BrowserUnavailableError(
    `Browser unavailable (${binary}): ${cause instanceof Error ? cause.message : String(cause)}. ${recovery}${stderr.trim() ? `\nBrowser stderr${diagnosticTruncated ? " (truncated)" : ""}:\n${stderr.trim()}` : ""}`,
    { cause },
  );
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 500);
  try {
    await bounded("Browser cleanup", 2_000, async () => stopped);
  } finally {
    clearTimeout(timeout);
  }
}

function debuggingEndpoint(child: ChildProcess, timeoutMs: number): Promise<string> {
  return bounded(
    "Browser startup",
    timeoutMs,
    async (signal) =>
      new Promise<string>((resolve, reject) => {
        let output = "";
        const cleanup = () => {
          child.removeListener("error", fail);
          child.removeListener("close", exited);
          child.stderr?.removeListener("data", data);
          signal.removeEventListener("abort", aborted);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null) =>
          fail(
            new Error(
              `browser exited before becoming ready (${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`})`,
            ),
          );
        const aborted = () => fail(new Error("browser startup timed out"));
        const data = (chunk: Buffer) => {
          output = (output + String(chunk)).slice(-8192);
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
          if (!match?.[1]) return;
          const url = new URL(match[1]);
          if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
            fail(new Error("browser endpoint is not loopback"));
            return;
          }
          cleanup();
          resolve(url.href);
        };
        child.once("error", fail);
        // close follows the final stderr bytes; exit can precede their delivery.
        child.once("close", exited);
        child.stderr?.on("data", data);
        signal.addEventListener("abort", aborted, { once: true });
      }),
  );
}

async function connect(
  endpoint: string,
  startupTimeoutMs: number,
  timeoutMs: number,
): Promise<ChromeTransport> {
  const socket = new WebSocket(endpoint);
  try {
    await bounded(
      "Browser connection",
      startupTimeoutMs,
      async () =>
        new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("browser connection failed")), {
            once: true,
          });
        }),
    );
  } catch (cause) {
    socket.close();
    throw cause;
  }
  let sequence = 0;
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(cause: Error): void }
  >();
  const listeners = new Set<Parameters<ChromeTransport["onEvent"]>[0]>();
  const dispatchEvent = (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ) => {
    for (const listener of listeners) listener({ method, params, sessionId });
  };
  socket.addEventListener("message", (event) => {
    let response: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    try {
      response = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (response.method) {
      dispatchEvent(response.method, response.params, response.sessionId);
      return;
    }
    const request = response.id === undefined ? undefined : pending.get(response.id);
    if (!request || response.id === undefined) return;
    pending.delete(response.id);
    if (response.error) request.reject(new BrowserRuntimeError(response.error.message));
    else request.resolve(response.result ?? {});
  });
  const rejectPending = () => {
    for (const request of pending.values())
      request.reject(new BrowserRuntimeError("browser disconnected"));
    pending.clear();
  };
  socket.addEventListener("close", rejectPending);
  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(method, params = {}, sessionId) {
      const id = ++sequence;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BrowserRuntimeError(`${method} timed out`, "timed-out"));
        }, timeoutMs);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(cause) {
            clearTimeout(timer);
            reject(cause);
          },
        });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch (cause) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new BrowserRuntimeError(cause instanceof Error ? cause.message : String(cause)));
        }
      });
    },
    async close() {
      listeners.clear();
      rejectPending();
      socket.close();
    },
  };
}
