import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProjectServer,
  parseProjectUrl,
  resolveProjectPath,
  startProjectServer,
} from "../../../src/testing/project-server.js";

let base: string;
let root: string;
let outside: string;
const started: ProjectServer[] = [];
const start = async (
  options: { blockedPaths?: string[]; maxRequests?: number; maxBytes?: number } = {},
) => {
  const server = await startProjectServer({ root, ...options });
  started.push(server);
  return server;
};

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "visp-project-server-"));
  root = join(base, "project");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET");
  await writeFile(join(base, "secret.txt"), "SIBLING-SECRET");
  await writeFile(join(root, "index.html"), "<!doctype html><title>root</title>");
  await writeFile(join(root, "game.js"), "export const ok = true;");
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "index.html"), "<p>sub</p>");
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
  await rm(base, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
/** Sends the path byte for byte: Node's client does not normalise dot segments or escapes. */
function send(
  server: ProjectServer,
  path: string,
  options: { method?: string; host?: string } = {},
): Promise<Answer> {
  const url = new URL(server.origin);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path,
        method: options.method ?? "GET",
        headers: { host: options.host ?? url.host },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const refused = (answer: Answer) => {
  expect([400, 403, 404, 405, 503]).toContain(answer.status);
  expect(answer.body).not.toContain("SECRET");
};

describe("serving", () => {
  it("serves project bytes on loopback with the hardening headers", async () => {
    const server = await start();
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const answer = await send(server, "/game.js");
    expect(answer).toMatchObject({ status: 200, body: "export const ok = true;" });
    expect(answer.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-length": "23",
    });
  });

  it("serves index.html for the root and for directories, and ignores the query", async () => {
    const server = await start();
    expect((await send(server, "/")).body).toContain("<title>root</title>");
    expect((await send(server, "/?x=1")).body).toContain("<title>root</title>");
    expect((await send(server, "/index.html?level=2")).status).toBe(200);
    expect((await send(server, "/sub/")).body).toBe("<p>sub</p>");
  });

  it("redirects a directory to its trailing slash so relative URLs resolve", async () => {
    const server = await start();
    const answer = await send(server, "/sub?x=1");
    expect(answer.status).toBe(301);
    expect(answer.headers.location).toBe("/sub/?x=1");
  });

  it("labels text with utf-8 and knows common asset types", async () => {
    await writeFile(join(root, "notes.txt"), "hi");
    await writeFile(join(root, "favicon.ico"), "x");
    await writeFile(join(root, "game.js.map"), "{}");
    await writeFile(join(root, "site.webmanifest"), "{}");
    await writeFile(join(root, "theme.mp3"), "x");
    const server = await start();
    const type = async (path: string) => (await send(server, path)).headers["content-type"];
    expect(await type("/")).toBe("text/html; charset=utf-8");
    expect(await type("/notes.txt")).toBe("text/plain; charset=utf-8");
    expect(await type("/favicon.ico")).toBe("image/x-icon");
    expect(await type("/game.js.map")).toBe("application/json; charset=utf-8");
    expect(await type("/site.webmanifest")).toBe("application/manifest+json");
    expect(await type("/theme.mp3")).toBe("audio/mpeg");
  });

  it("answers 404 for a slash after a file name", async () => {
    const server = await start();
    expect((await send(server, "/game.js/")).status).toBe(404);
    expect((await send(server, "/index.html/")).status).toBe(404);
  });

  it("answers HEAD with the headers and no body", async () => {
    const server = await start();
    const answer = await send(server, "/game.js", { method: "HEAD" });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe("");
    expect(answer.headers["content-length"]).toBe("23");
  });

  it("answers 404 for a missing file and for a missing index", async () => {
    const server = await start();
    expect((await send(server, "/missing.png")).status).toBe(404);
    await mkdir(join(root, "empty"));
    expect((await send(server, "/empty/")).status).toBe(404);
  });

  it("presents, resolves and digests without the port", async () => {
    const server = await start();
    expect(server.resolve("project:/sub/?a=1#h")).toBe(`${server.origin}/sub/?a=1#h`);
    expect(server.present(`${server.origin}/sub/?a=1`)).toBe("project:/sub/?a=1");
    expect(server.present("https://example.com/")).toBe("https://example.com/");
    expect(server.digestOf(`${server.origin}/game.js`)).toBeUndefined();
    await send(server, "/game.js");
    await send(server, "/missing.png");
    expect(server.digestOf(`${server.origin}/game.js?v=2`)).toMatch(/^[0-9a-f]{64}$/);
    expect(server.digestOf(`${server.origin}/missing.png`)).toBeUndefined();
  });
});

describe("path traversal", () => {
  it.each([
    "/../secret.txt",
    "/sub/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/%2E%2E/secret.txt",
    "/.%2e/secret.txt",
    "/sub/%2e%2e/%2e%2e/secret.txt",
    "/sub/..%2fsecret.txt",
    "/sub/..%2Fsecret.txt",
    "/..%5csecret.txt",
    "/sub%2f..%2f..%2fsecret.txt",
    "/sub\\..\\..\\secret.txt",
    "/..\\secret.txt",
    "/%5c..%5csecret.txt",
    "/%2e%2e%2f%2e%2e%2fsecret.txt",
    "//secret.txt",
    "//etc/passwd",
    "/%00",
    "/index.html%00.png",
    "/%c0%ae%c0%ae/secret.txt",
    "/%zz",
    "/%",
    "http://evil.test/secret.txt",
    "*",
  ])("refuses %s", async (path) => {
    const server = await start();
    refused(await send(server, path));
  });

  it("refuses an absolute filesystem path", async () => {
    const server = await start();
    refused(await send(server, `/${join(outside, "secret.txt")}`));
    refused(await send(server, `/${join(outside, "secret.txt").replaceAll("/", "%2f")}`));
  });

  it("rejects the decoded forms directly", () => {
    for (const path of ["/a/../b", "/%2e%2e", "/a%2fb", "/a\\b", "/a%00b", "//a"])
      expect(resolveProjectPath(path).ok).toBe(false);
    expect(resolveProjectPath("/a/./b/")).toEqual({ ok: true, path: "a/b", directory: true });
    expect(resolveProjectPath("/")).toEqual({ ok: true, path: "", directory: true });
    expect(resolveProjectPath("/a%20b.png")).toEqual({
      ok: true,
      path: "a b.png",
      directory: false,
    });
  });

  it("refuses Windows alias spellings only on Windows", () => {
    for (const path of ["/.env::$DATA", "/.env.", "/.env%20", "/GIT~1/config"]) {
      expect(resolveProjectPath(path, "win32").ok).toBe(false);
    }
    expect(resolveProjectPath("/notes:v1.txt", "linux").ok).toBe(true);
  });
});

describe("symlinks", () => {
  it("refuses a file symlink to outside the project", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const server = await start();
    const answer = await send(server, "/link.txt");
    expect(answer.status).toBe(403);
    refused(answer);
  });

  it("refuses a directory symlink to outside, at any depth", async () => {
    await symlink(outside, join(root, "linked"));
    const server = await start();
    for (const path of ["/linked/secret.txt", "/linked", "/linked/", "/sub/../linked/secret.txt"])
      refused(await send(server, path));
    await symlink(outside, join(root, "sub", "deep"));
    refused(await send(server, "/sub/deep/secret.txt"));
  });

  it("refuses a dangling symlink and a symlink to another project file", async () => {
    await symlink(join(root, "nowhere"), join(root, "dangling.html"));
    await symlink(join(root, "index.html"), join(root, "alias.html"));
    const server = await start();
    expect((await send(server, "/dangling.html")).status).toBe(403);
    expect((await send(server, "/alias.html")).status).toBe(403);
  });

  it("refuses an index.html that is a symlink to outside", async () => {
    await mkdir(join(root, "page"));
    await symlink(join(outside, "secret.txt"), join(root, "page", "index.html"));
    const server = await start();
    refused(await send(server, "/page/"));
  });
});

describe("blocked paths", () => {
  beforeEach(async () => {
    await writeFile(join(root, ".env"), "TOKEN=SECRET");
    await writeFile(join(root, ".env.local"), "TOKEN=SECRET");
    await mkdir(join(root, "sub2"));
    await writeFile(join(root, "sub2", ".env"), "TOKEN=SECRET");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "SECRET");
    await mkdir(join(root, ".visp"));
    await writeFile(join(root, ".visp", "state.json"), "SECRET");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "x.js"), "SECRET");
    await mkdir(join(root, "sub", "node_modules"));
    await writeFile(join(root, "sub", "node_modules", "y.js"), "SECRET");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "app.js"), "SECRET");
    await mkdir(join(root, "build"));
    await writeFile(join(root, "build", "app.js"), "SECRET");
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private", "notes.txt"), "SECRET");
  });

  it.each([
    "/.env",
    "/.env.local",
    "/sub2/.env",
    "/.ENV",
    "/.Env.Local",
    "/%2eenv",
    "/.git/config",
    "/.GIT/config",
    "/.git/",
    "/.git",
    "/.visp/state.json",
    "/.VISP/state.json",
    "/node_modules/x.js",
    "/sub/node_modules/y.js",
    "/dist/app.js",
    "/build/app.js",
    "/private/notes.txt",
    "/Private/notes.txt",
  ])("refuses %s", async (path) => {
    const server = await start({ blockedPaths: ["private"] });
    const answer = await send(server, path);
    refused(answer);
    expect([403, 404]).toContain(answer.status);
  });

  it("does not turn a blocked directory into a redirect", async () => {
    const server = await start();
    for (const path of ["/dist", "/.git", "/node_modules"])
      expect((await send(server, path)).status).toBe(403);
  });

  it("refuses a file that is a second name for a blocked file (hard link)", async () => {
    await writeFile(join(root, ".env"), "TOKEN=SECRET");
    await link(join(root, ".env"), join(root, "innocent.txt"));
    const server = await start();
    refused(await send(server, "/innocent.txt"));
  });

  it("folds letter case the Unicode way, so dotless-i spellings stay blocked", async () => {
    const server = await start();
    expect((await send(server, "/.g%C4%B1t/config")).status).toBe(403);
    expect((await send(server, "/.g%C4%B1t")).status).toBe(403);
  });

  it("records what it refused, printable and bounded", async () => {
    const server = await start();
    await send(server, "/.env");
    await send(server, `/${"a".repeat(500)}%00`);
    await send(server, "/game.js", { method: "POST" });
    expect(server.refusals).toHaveLength(3);
    expect(server.refusals[0]).toBe("403 GET /.env: blocked project path");
    expect(server.refusals[1]?.length).toBeLessThan(160);
    expect(server.refusals[2]).toContain("only GET and HEAD");
    for (let i = 0; i < 20; i += 1) await send(server, "/.env");
    expect(server.refusals).toHaveLength(5);
    expect(server.refusalCount).toBe(23);
  });
});

describe("methods and Host", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])("answers %s with 405", async (method) => {
    const server = await start();
    const answer = await send(server, "/index.html", { method });
    expect(answer.status).toBe(405);
    expect(answer.headers.allow).toBe("GET, HEAD");
  });

  it.each(["evil.test", "localhost", "127.0.0.1", "127.0.0.1:1", "attacker.example:80"])(
    "answers 403 to Host %j",
    async (host) => {
      const server = await start();
      const answer = await send(server, "/index.html", { host });
      expect(answer.status).toBe(403);
      expect(answer.body).not.toContain("root");
      expect((await send(server, "/index.html", { host, method: "POST" })).status).toBe(403);
    },
  );

  it("answers 403 when the request has no Host header at all", async () => {
    const server = await start();
    const { hostname, port } = new URL(server.origin);
    const socket = connect(Number(port), hostname);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write("GET /index.html HTTP/1.0\r\n\r\n");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const text = Buffer.concat(chunks).toString();
    expect(text).toMatch(/^HTTP\/1\.[01] 403/);
    expect(text).not.toContain("root");
  });

  it("does not serve localhost:<port> (name resolution is not the server's business)", async () => {
    const server = await start();
    const port = new URL(server.origin).port;
    expect((await send(server, "/index.html", { host: `localhost:${port}` })).status).toBe(403);
  });
});

describe("budgets and lifecycle", () => {
  it("refuses requests beyond the request budget", async () => {
    const server = await start({ maxRequests: 3 });
    for (let i = 0; i < 3; i += 1) expect((await send(server, "/game.js")).status).toBe(200);
    const answer = await send(server, "/game.js");
    expect(answer.status).toBe(503);
    expect(server.refusals.at(-1)).toContain("request budget");
  });

  it("allows a generous default request budget", async () => {
    const server = await start();
    for (let i = 0; i < 60; i += 1) await send(server, "/.env");
    expect((await send(server, "/game.js")).status).toBe(200);
  });

  it("reserves the byte budget from the file size before reading", async () => {
    await writeFile(join(root, "big.bin"), Buffer.alloc(400));
    const server = await start({ maxBytes: 300 });
    expect((await send(server, "/big.bin")).status).toBe(503);
    expect((await send(server, "/game.js")).status).toBe(200);
    const [a, b] = await Promise.all([send(server, "/game.js"), send(server, "/game.js")]);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it("counts refused requests against the request budget", async () => {
    const server = await start({ maxRequests: 2 });
    await send(server, "/.env");
    await send(server, "/.env");
    expect((await send(server, "/game.js")).status).toBe(503);
  });

  it("refuses bytes beyond the byte budget but keeps serving small files", async () => {
    await writeFile(join(root, "big.bin"), Buffer.alloc(100));
    const server = await start({ maxBytes: 150 });
    expect((await send(server, "/big.bin")).status).toBe(200);
    const over = await send(server, "/big.bin");
    expect(over.status).toBe(503);
    expect(over.body).not.toContain("\0");
    expect(server.refusals.at(-1)).toContain("byte budget");
    expect((await send(server, "/game.js")).status).toBe(200);
  });

  it("refuses a file above the per-file cap", async () => {
    await writeFile(join(root, "huge.bin"), Buffer.alloc(1));
    const server = await start();
    // The shared reader's 32 MiB cap is exercised in browser-files.test; here a sparse file is enough.
    const { truncate } = await import("node:fs/promises");
    await truncate(join(root, "huge.bin"), 33 * 1024 * 1024);
    expect((await send(server, "/huge.bin")).status).toBe(403);
  });

  it("frees the port on close, drops open connections and closes twice safely", async () => {
    const server = await start();
    const { hostname, port } = new URL(server.origin);
    const idle = connect(Number(port), hostname);
    await new Promise<void>((resolve) => idle.once("connect", () => resolve()));
    const dropped = new Promise<void>((resolve) => idle.once("close", () => resolve()));
    await server.close();
    await server.close();
    await dropped;
    await expect(send(server, "/")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("binds only the loopback interface", async () => {
    const server = await start();
    expect(new URL(server.origin).hostname).toBe("127.0.0.1");
  });

  it("never lets a request handler crash the process", async () => {
    const server = await start();
    await writeFile(join(root, "notdir"), "x");
    const answer = await send(server, "/notdir/child");
    expect([403, 404]).toContain(answer.status);
    expect((await send(server, "/game.js")).status).toBe(200);
  });
});

describe("project URL contract", () => {
  it("accepts an absolute path with query and hash", () => {
    expect(parseProjectUrl("project:/index.html")).toEqual({
      pathname: "/index.html",
      search: "",
      hash: "",
    });
    expect(parseProjectUrl("project:/a/b.html?x=1#top")).toEqual({
      pathname: "/a/b.html",
      search: "?x=1",
      hash: "#top",
    });
    expect(parseProjectUrl("project:/")).toMatchObject({ pathname: "/" });
  });

  it.each([
    "project://host/index.html",
    "project:///index.html",
    "project://user@host/",
    "project:index.html",
    "project:%2e%2e/secret",
    "project:/%2e%2e/secret",
    "project:/a%2f..%2fb",
    "project:/a\\b",
    "project:/%00",
    "http://127.0.0.1/",
  ])("refuses %s", (value) => {
    expect(parseProjectUrl(value)).toHaveProperty("error");
  });
});
