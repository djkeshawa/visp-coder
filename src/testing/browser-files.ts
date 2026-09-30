import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BLOCKED_PATHS } from "../core/constants.js";
import { ProjectFileSystem } from "../core/fs.js";
import { matchesAny } from "../core/patterns.js";
import type { PageSend } from "./browser-session.js";
import type { ChromeTransport } from "./chrome-transport.js";

export class BrowserSecurityError extends Error {}

const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** File requests are fulfilled from confined reads; Chrome never follows a checked path later. */
export async function readBrowserFile(root: string, url: string, blocked: readonly string[] = []) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") throw new BrowserSecurityError("Expected a local file URL");
  const files = new ProjectFileSystem(root);
  const path = fileURLToPath(parsed);
  const metadata = await files.metadata(path);
  if (!metadata.ok) throw new BrowserSecurityError(metadata.error.message);
  const inside = projectRelative(files.root, resolve(root), path);
  const projectPath = inside?.replaceAll("\\", "/");
  if (!projectPath || matchesAny(projectPath, [...DEFAULT_BLOCKED_PATHS, ...blocked]))
    throw new BrowserSecurityError("Local browser file is outside allowed project content");
  if (!metadata.value) return { bytes: null, type: contentType(path) };
  if (metadata.value?.type !== "file" || metadata.value.size > MAX_FILE_BYTES)
    throw new BrowserSecurityError("Local browser input must be a regular file of at most 32 MiB");
  const bytes = await readPinned(path, join(files.root, projectPath));
  if (!bytes) return { bytes: null, type: contentType(path) };
  return { bytes, type: contentType(path) };
}

/** Path under the canonical root, or under the root as the caller spelled it; never `..`. */
function projectRelative(canonical: string, requested: string, path: string): string | undefined {
  for (const base of [canonical, requested]) {
    const rel = relative(base, path);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
  }
  return undefined;
}

/**
 * The checks above look at a path; a swap between them and the read would follow a new link. So the
 * read is pinned: open without following a final link, require a regular single-link file on the
 * descriptor, and read from the descriptor. Where the kernel can name what a descriptor is open on
 * (Linux /proc/self/fd) that real location must be the canonical in-root path, which also catches a
 * parent directory swapped for a link. Elsewhere (darwin, win32) the only check is to lstat and
 * realpath the path again afterwards and compare dev/ino: two separate lookups, so weaker against a
 * parent directory flipped between a directory and a link, and O_NOFOLLOW is missing on Windows.
 */
async function readPinned(path: string, canonical: string): Promise<Uint8Array | null> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (!noFollow && (await lstat(path)).isSymbolicLink())
    throw new BrowserSecurityError("Local browser file must not be a symlink");
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BrowserSecurityError(`Local browser file cannot be opened: ${errorMessage(cause)}`);
  }
  try {
    return await readOpened(handle, path, canonical);
  } catch (cause) {
    if (cause instanceof BrowserSecurityError) throw cause;
    throw new BrowserSecurityError(`Local browser file cannot be read: ${errorMessage(cause)}`);
  } finally {
    await handle.close();
  }
}

async function readOpened(
  handle: Awaited<ReturnType<typeof open>>,
  path: string,
  canonical: string,
): Promise<Uint8Array> {
  const location = await openedLocation(handle.fd);
  if (location !== undefined && location !== canonical)
    throw new BrowserSecurityError("Local browser file is not at its project location");
  const pinned = await handle.stat({ bigint: true });
  if (!pinned.isFile() || pinned.size > BigInt(MAX_FILE_BYTES) || pinned.nlink > 1n)
    throw new BrowserSecurityError(
      "Local browser input must be a regular, single-link file of at most 32 MiB",
    );
  const bytes = await handle.readFile();
  if (bytes.length > MAX_FILE_BYTES)
    throw new BrowserSecurityError("Local browser file is missing or too large");
  if (location === undefined) await assertStillThere(path, canonical, pinned);
  return bytes;
}

/** Where an open descriptor really lives, or undefined where the platform cannot say. */
async function openedLocation(fd: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return await readlink(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** Fallback recheck: the path still names the descriptor's file at its canonical location. */
async function assertStillThere(
  path: string,
  canonical: string,
  pinned: { dev: bigint; ino: bigint },
) {
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    current.dev !== pinned.dev ||
    current.ino !== pinned.ino ||
    (await realpath(path)) !== canonical
  )
    throw new BrowserSecurityError("Local browser file changed while it was read");
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
      bytesRead += loaded.bytes?.length ?? 0;
      if (bytesRead > 128 * 1024 * 1024) throw new Error("Local browser input budget exceeded");
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: loaded.bytes === null ? 404 : 200,
        responseHeaders: [
          { name: "Content-Type", value: loaded.type },
          { name: "Content-Security-Policy", value: "worker-src 'none'" },
        ],
        body: loaded.bytes === null ? "" : Buffer.from(loaded.bytes).toString("base64"),
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

export function contentType(path: string): string {
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
    ".txt": "text/plain",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".map": "application/json",
    ".webmanifest": "application/manifest+json",
    ".xml": "application/xml",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
