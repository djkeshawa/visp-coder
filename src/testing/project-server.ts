import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BLOCKED_PATHS } from "../core/constants.js";
import { ProjectFileSystem } from "../core/fs.js";
import { sha256 } from "../core/hash.js";
import { matchesAny } from "../core/patterns.js";
import { BrowserSecurityError, readBrowserFile } from "./browser-files.js";

/** Journey URL scheme for "serve this project's files"; the server behind it is VISP's own. */
export const PROJECT_SCHEME = "project:";

const MAX_REQUESTS = 20_000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_REFUSALS = 5;
const MAX_LISTED_PATH = 80;

/** `project:/<path>[?query][#hash]`: no authority, an absolute path that stays inside the project. */
export function parseProjectUrl(
  value: string,
): { pathname: string; search: string; hash: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "Project URL is not a valid URL" };
  }
  if (url.protocol !== PROJECT_SCHEME || value.slice(PROJECT_SCHEME.length).startsWith("//"))
    return { error: 'Project URL must look like "project:/index.html"' };
  if (url.host || url.username || url.password || !url.pathname.startsWith("/"))
    return { error: 'Project URL needs no host and an absolute path, like "project:/index.html"' };
  // The URL parser resolves `..` and `%2e%2e` on its own; judge the text the author wrote.
  const written = value.slice(PROJECT_SCHEME.length).split(/[?#]/, 1)[0] ?? "";
  const resolved = resolveProjectPath(written);
  if (!resolved.ok) return { error: `Project URL path is not allowed: ${resolved.reason}` };
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

export type ResolvedProjectPath =
  | { readonly ok: true; readonly path: string; readonly directory: boolean }
  | { readonly ok: false; readonly status: 400 | 403; readonly reason: string };

/**
 * Turn the raw request path into a project-relative path, or refuse it. Decoding happens exactly
 * once and every check runs on the decoded text, so no spelling of `..`, a separator or a NUL
 * reaches the file system.
 */
export function resolveProjectPath(
  rawPathname: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedProjectPath {
  const refuse = (status: 400 | 403, reason: string): ResolvedProjectPath => ({
    ok: false,
    status,
    reason,
  });
  if (!rawPathname.startsWith("/") || rawPathname.startsWith("//"))
    return refuse(400, "path must be absolute and start with a single slash");
  if (/%2f|%5c/i.test(rawPathname)) return refuse(400, "encoded path separators are not served");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return refuse(400, "path is not valid percent-encoding");
  }
  if ([...decoded].some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f"))
    return refuse(400, "path contains a control character");
  if (decoded.includes("\\")) return refuse(400, "backslashes are not served");
  const segments = decoded.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".."))
    return refuse(403, "parent directory segments are not served");
  if (platform === "win32" && segments.some(windowsAlias))
    return refuse(403, "path uses a Windows alias form");
  return {
    ok: true,
    path: segments.join("/"),
    directory: segments.length === 0 || decoded.endsWith("/"),
  };
}

/** Streams (`:`), trailing dots or spaces and 8.3 short names reach files a pattern does not name. */
function windowsAlias(segment: string): boolean {
  return segment.includes(":") || /[. ]$/.test(segment) || /~\d/.test(segment);
}

/** Upper-then-lower folds more spellings together than lower alone (dotless i, long s). */
const fold = (text: string) => text.toUpperCase().toLowerCase();

/** Names that hold secrets or VISP state wherever they sit in the tree, in any letter case. */
function secretSegment(segment: string): boolean {
  const name = fold(segment);
  return (
    name === ".git" ||
    name === ".visp" ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "node_modules"
  );
}

export interface ProjectServer {
  /** `http://127.0.0.1:<port>`; the port is ephemeral and never part of a journey's identity. */
  readonly origin: string;
  /** The first refused requests (blocked path, bad method, budget), oldest first, at most five. */
  readonly refusals: readonly string[];
  /** How many requests were refused in all. */
  readonly refusalCount: number;
  /** The loopback URL that serves a `project:` journey URL. */
  resolve(projectUrl: string): string;
  /** `project:` spelling of any URL on this server, for operation text. */
  present(url: string): string;
  /** sha256 of the bytes last served for that URL's path, when a 200 was served. */
  digestOf(url: string): string | undefined;
  /** Stop listening and drop every open connection; safe to call more than once. */
  close(): Promise<void>;
}

export interface ProjectServerOptions {
  readonly root: string;
  readonly blockedPaths?: readonly string[];
  readonly maxRequests?: number;
  readonly maxBytes?: number;
}

interface Refusal {
  readonly status: number;
  readonly reason: string;
  readonly headers?: Record<string, string>;
}
interface Screened {
  readonly rawPath: string;
  readonly path: string;
  readonly directory: boolean;
}

/**
 * Read-only static server for one journey: loopback only, GET and HEAD only, bytes come through
 * `readBrowserFile` (canonical root, symlink refusal, blocked paths, 32 MiB per file), so the page
 * a journey shows is the current project bytes. `dist/`, `build/` and `node_modules/` are not
 * served: apps that need them run their own server.
 */
export async function startProjectServer(options: ProjectServerOptions): Promise<ProjectServer> {
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const blocked = [".visp", ...(options.blockedPaths ?? [])];
  const patterns = [...DEFAULT_BLOCKED_PATHS, ...blocked];
  const foldedPatterns = patterns.map(fold);
  const files = new ProjectFileSystem(options.root);
  const refusals: string[] = [];
  let refusalCount = 0;
  const digests = new Map<string, string>();
  let requests = 0;
  let bytesServed = 0;
  let host = "";

  const isBlocked = (path: string) =>
    path.split("/").some(secretSegment) ||
    matchesAny(path, patterns) ||
    matchesAny(fold(path), foldedPatterns);
  const kindOf = async (path: string) => {
    const metadata = await files.metadata(path);
    return metadata.ok ? metadata.value?.type : undefined;
  };
  const isDirectory = async (path: string) => (await kindOf(path)) === "directory";
  const isFile = async (path: string) => (await kindOf(path)) === "file";

  const send = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    headers: Record<string, string | number>,
    body?: Uint8Array,
  ) => {
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      ...headers,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const sendText = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    text: string,
    headers: Record<string, string> = {},
  ) => {
    const body = Buffer.from(text);
    send(
      request,
      response,
      status,
      { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length, ...headers },
      body,
    );
  };
  const refuse = (request: IncomingMessage, response: ServerResponse, refusal: Refusal) => {
    refusalCount += 1;
    if (refusals.length < MAX_REFUSALS)
      refusals.push(`${refusal.status} ${describe(request)}: ${refusal.reason}`);
    sendText(
      request,
      response,
      refusal.status,
      `${refusal.status} ${refusal.reason}\n`,
      refusal.headers,
    );
  };

  /** Budget, Host, method and path checks: everything decided before the file system is touched. */
  const screen = (request: IncomingMessage): Screened | Refusal => {
    requests += 1;
    if (requests > maxRequests)
      return { status: 503, reason: "request budget for this journey exceeded" };
    if (request.headers.host !== host) return { status: 403, reason: "unexpected Host header" };
    if (request.method !== "GET" && request.method !== "HEAD")
      return {
        status: 405,
        reason: "only GET and HEAD are served",
        headers: { Allow: "GET, HEAD" },
      };
    const rawPath = (request.url ?? "").split(/[?#]/, 1)[0] ?? "";
    const resolved = resolveProjectPath(rawPath);
    if (!resolved.ok) return { status: resolved.status, reason: resolved.reason };
    if (isBlocked(resolved.path)) return { status: 403, reason: "blocked project path" };
    return { rawPath, path: resolved.path, directory: resolved.directory };
  };

  const serveFile = async (
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    rawPath: string,
  ) => {
    if (isBlocked(path))
      return refuse(request, response, { status: 403, reason: "blocked project path" });
    // Reserve the size before the read: concurrent requests cannot overshoot the byte budget.
    const stat = await files.metadata(join(options.root, path));
    const reserved = stat.ok && stat.value?.type === "file" ? stat.value.size : 0;
    if (bytesServed + reserved > maxBytes)
      return refuse(request, response, {
        status: 503,
        reason: "byte budget for this journey exceeded",
      });
    bytesServed += reserved;
    let served = 0;
    try {
      const loaded = await readBrowserFile(
        options.root,
        pathToFileURL(join(options.root, path)).href,
        blocked,
      );
      if (loaded.bytes === null) return sendText(request, response, 404, "404 not found\n");
      served = loaded.bytes.length;
      if (request.method === "GET" && digests.size < maxRequests)
        digests.set(rawPath, sha256(loaded.bytes));
      send(
        request,
        response,
        200,
        { "Content-Type": withCharset(loaded.type), "Content-Length": served },
        loaded.bytes,
      );
    } finally {
      bytesServed += served - reserved;
    }
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const screened = screen(request);
    if ("status" in screened) return refuse(request, response, screened);
    const { rawPath, path, directory } = screened;
    if (directory) {
      // A slash after a file name names nothing.
      if (path && (await isFile(join(options.root, path))))
        return sendText(request, response, 404, "404 not found\n");
      return serveFile(request, response, path ? `${path}/index.html` : "index.html", rawPath);
    }
    if (await isDirectory(join(options.root, path)))
      // Relative URLs in the page resolve against the directory, so it needs its trailing slash.
      return send(request, response, 301, {
        Location: `${rawPath}/${(request.url ?? "").slice(rawPath.length)}`,
        "Content-Length": 0,
      });
    return serveFile(request, response, path, rawPath);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((cause) => {
      if (response.headersSent) return void response.destroy();
      refuse(
        request,
        response,
        cause instanceof BrowserSecurityError
          ? { status: 403, reason: "path is outside allowed project content" }
          : { status: 500, reason: "internal error" },
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  let closing: Promise<void> | undefined;
  return {
    origin,
    refusals,
    get refusalCount() {
      return refusalCount;
    },
    resolve(projectUrl) {
      const parsed = parseProjectUrl(projectUrl);
      if ("error" in parsed) throw new BrowserSecurityError(parsed.error);
      return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    },
    present(url) {
      return url.startsWith(`${origin}/`) ? `${PROJECT_SCHEME}${url.slice(origin.length)}` : url;
    },
    digestOf(url) {
      try {
        return digests.get(new URL(url).pathname);
      } catch {
        return undefined;
      }
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/** Method and a printable, bounded path: the request line comes from an untrusted client. */
function describe(request: IncomingMessage): string {
  const path = (request.url ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, MAX_LISTED_PATH);
  return `${(request.method ?? "").slice(0, 16).replace(/[^A-Za-z]/g, "?")} ${path}`;
}

/** Text a page reads must say how it is encoded; everything else keeps its bare type. */
function withCharset(type: string): string {
  return ["text/html", "text/css", "text/javascript", "application/json", "text/plain"].includes(
    type,
  )
    ? `${type}; charset=utf-8`
    : type;
}
