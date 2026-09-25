import { extname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BLOCKED_PATHS } from "../core/constants.js";
import { ProjectFileSystem } from "../core/fs.js";
import { matchesAny } from "../core/patterns.js";
import type { PageSend } from "./browser-session.js";
import type { ChromeTransport } from "./chrome-transport.js";

export class BrowserSecurityError extends Error {}

/** File requests are fulfilled from confined reads; Chrome never follows a checked path later. */
export async function readBrowserFile(root: string, url: string, blocked: readonly string[] = []) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") throw new BrowserSecurityError("Expected a local file URL");
  const files = new ProjectFileSystem(root);
  const path = fileURLToPath(parsed);
  const metadata = await files.metadata(path);
  if (!metadata.ok) throw new BrowserSecurityError(metadata.error.message);
  const projectPath = relative(files.root, path).replaceAll("\\", "/");
  if (!projectPath || matchesAny(projectPath, [...DEFAULT_BLOCKED_PATHS, ...blocked]))
    throw new BrowserSecurityError("Local browser file is outside allowed project content");
  if (metadata.value?.type !== "file" || metadata.value.size > 32 * 1024 * 1024)
    throw new BrowserSecurityError("Local browser input must be a regular file of at most 32 MiB");
  const bytes = await files.readBytesIfExists(path);
  if (!bytes.ok) throw new BrowserSecurityError(bytes.error.message);
  if (!bytes.value || bytes.value.length > 32 * 1024 * 1024)
    throw new BrowserSecurityError("Local browser file is missing or too large");
  return { bytes: bytes.value, type: contentType(path) };
}

export async function confineBrowserFiles(
  transport: ChromeTransport,
  send: PageSend,
  root: string,
  blocked: readonly string[] = [],
) {
  const failures: string[] = [];
  const fail = (message: string) => {
    if (failures.length < 3) failures.push(message);
  };
  const initial = await transport.send("Target.getTargets");
  const initialBlank = new Set(
    (initial.targetInfos as { targetId: string; url: string }[])
      .filter((target) => target.url === "about:blank")
      .map((target) => target.targetId),
  );
  const pending = new Set<Promise<void>>();
  let bytesRead = 0;
  let requests = 0;
  const extraTarget = async (event: Parameters<Parameters<ChromeTransport["onEvent"]>[0]>[0]) => {
    const target = event.params.targetInfo as { targetId?: string; url?: string; type?: string };
    if (!target.targetId || target.targetId === send.targetId) return;
    if (
      target.type === "browser_ui" ||
      target.type === "background_page" ||
      target.url?.startsWith("chrome-extension://")
    )
      return;
    if (!initialBlank.has(target.targetId))
      fail("Local-file journeys cannot open extra browsing targets");
    await transport.send("Target.closeTarget", { targetId: target.targetId });
  };
  const fulfill = async (params: Record<string, unknown>) => {
    const requestId = params.requestId;
    try {
      if (++requests > 2000) throw new Error("Local browser request budget exceeded");
      const request = params.request as { url: string; method: string };
      if (request.method !== "GET") throw new Error("Local browser files support GET only");
      const loaded = await readBrowserFile(root, request.url, blocked);
      bytesRead += loaded.bytes.length;
      if (bytesRead > 128 * 1024 * 1024) throw new Error("Local browser input budget exceeded");
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Content-Type", value: loaded.type },
          { name: "Content-Security-Policy", value: "worker-src 'none'" },
        ],
        body: Buffer.from(loaded.bytes).toString("base64"),
      });
    } catch (cause) {
      fail(errorMessage(cause));
      await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    }
  };
  const handle = async (event: Parameters<Parameters<ChromeTransport["onEvent"]>[0]>[0]) => {
    if (event.method === "Target.attachedToTarget") return extraTarget(event);
    if (event.method === "Log.entryAdded") {
      const entry = event.params.entry as { source?: string; level?: string };
      if (entry.source === "security" && entry.level === "error")
        fail(
          "Local-file browser security policy blocked application behavior; use HTTP(S) for this journey",
        );
    }
    if (event.method === "Fetch.requestPaused" && event.sessionId === send.sessionId)
      await fulfill(event.params);
  };
  const unsubscribe = transport.onEvent((event) => {
    const work = handle(event).catch((cause) => {
      fail(String(cause));
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  try {
    await send("Log.enable");
    await send("Fetch.enable", { patterns: [{ urlPattern: "file:*", requestStage: "Request" }] });
    await transport.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}],
    });
    await send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}],
    });
    await transport.send("Browser.setDownloadBehavior", { behavior: "deny" });
  } catch (cause) {
    unsubscribe();
    throw cause;
  }
  return {
    async check() {
      while (pending.size) await Promise.all([...pending]);
      if (failures.length)
        throw new BrowserSecurityError(
          `Local-file browser gap: ${failures.slice(0, 3).join("; ")}`,
        );
    },
    dispose: unsubscribe,
  };
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".html": "text/html",
    ".htm": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
