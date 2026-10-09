import { spawn } from "node:child_process";
import { Command } from "commander";
import { EXIT, PRODUCT_NAME } from "../../core/constants.js";
import { fromUnknown, vispError } from "../../core/errors.js";
import { BUILD_ID } from "../../core/version.js";
import { removeLease, reusableLease, writeLease } from "../../ui/lease.js";
import { startUiServer } from "../../ui/server.js";
import { loadWorkspace } from "../../workflow/state.js";
import { isJson, options, projectRoot } from "../context.js";
import { emitError } from "../output.js";

interface UiOptions {
  port?: string;
  open?: boolean;
}

/**
 * Serving keeps the process alive. With --json it prints one envelope naming the
 * URL and keeps running, which is how an editor extension attaches.
 */
export function uiCommand(): Command {
  return new Command("ui")
    .description("Open a live, read-only dashboard of this repository's VISP work")
    .option("--port <port>", "Listen on this loopback port instead of a free one")
    .option("--no-open", "Print the address without opening a browser")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<UiOptions>(command);
      const json = isJson(opts);
      const port = parsePort(opts.port);
      if (port === null) {
        process.exitCode = emitError(
          "ui",
          vispError("UNSUPPORTED", "--port must be a number from 1 to 65535"),
          { json },
        );
        return;
      }
      const state = await loadWorkspace(projectRoot(opts));
      if (!state.ok) {
        process.exitCode = emitError("ui", state.error, { json });
        return;
      }
      const root = state.value.paths.root;
      const open = opts.open !== false;
      const existing = port === undefined ? await reusableLease(root, BUILD_ID) : undefined;
      if (existing) {
        const url = `http://127.0.0.1:${existing.port}/#t=${existing.token}`;
        announce({ url, port: existing.port, pid: existing.pid, reused: true, root, json });
        if (open) openBrowser(url);
        return;
      }
      await serve(root, port, open, json);
    });
}

async function serve(
  root: string,
  port: number | undefined,
  open: boolean,
  json: boolean,
): Promise<void> {
  try {
    const server = await startUiServer({ root, ...(port ? { port } : {}) });
    await writeLease({
      root,
      pid: process.pid,
      port: server.port,
      token: server.token,
      buildId: BUILD_ID,
    });
    announce({ url: server.url, port: server.port, pid: process.pid, reused: false, root, json });
    if (open) openBrowser(server.url);
    const stop = async () => {
      await removeLease(root);
      await server.close();
      process.exit(EXIT.ok);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (cause) {
    const error =
      (cause as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? vispError("UNSUPPORTED", `Port ${port} is already in use`, {
            recovery: `${PRODUCT_NAME} ui`,
          })
        : fromUnknown(cause, "IO_ERROR");
    process.exitCode = emitError("ui", error, { json });
  }
}

function parsePort(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function announce(input: {
  url: string;
  port: number;
  pid: number;
  reused: boolean;
  root: string;
  json: boolean;
}): void {
  if (input.json) {
    process.stdout.write(
      `${JSON.stringify({
        command: "ui",
        ok: true,
        data: {
          url: input.url,
          port: input.port,
          pid: input.pid,
          reused: input.reused,
          buildId: BUILD_ID,
        },
      })}\n`,
    );
    return;
  }
  const lines = input.reused
    ? [`The dashboard for ${input.root} is already running:`, `  ${input.url}`]
    : [
        `Dashboard for ${input.root}`,
        `  ${input.url}`,
        "",
        "Read-only and local to this machine. Keep the address private: it signs you in.",
        "Press Ctrl+C to stop.",
      ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The address is printed; a missing opener is not an error.
  }
}
