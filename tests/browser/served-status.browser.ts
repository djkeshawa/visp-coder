import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";

const page = "<!doctype html><title>ok</title><main id=app>Ready</main>";
let server: Server;
let base: string;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "visp-served-status-"));
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/redirect") {
      response.writeHead(302, { location: "/ok" }).end();
    } else if (path === "/missing") {
      response.writeHead(404, { "content-type": "text/html" }).end("<h1>No such page</h1>");
    } else if (path === "/start") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end(
          '<!doctype html><a id="empty" href="/empty404">empty</a> <a id="dead" href="http://127.0.0.1:1/">dead</a>',
        );
    } else if (path === "/empty404") {
      response.writeHead(404).end();
    } else if (path === "/broken") {
      response.writeHead(500, { "content-type": "text/html" }).end("<h1>Boom</h1>");
    } else {
      response.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

const run = (url: string) =>
  runBrowserJourney({
    directory,
    subjectDigest: "a".repeat(64),
    journey: { url, actions: [] },
  });
const navigation = (result: Awaited<ReturnType<typeof run>>) =>
  result.operations.find((operation) => operation.kind === "navigate")?.description;

describe("main-document HTTP status", () => {
  it("records a 200 answer and completes", async () => {
    const result = await run(`${base}/ok`);
    expect(result.status).toBe("completed");
    expect(navigation(result)).toBe(`Navigate ${base}/ok (HTTP 200)`);
  });

  it("does not report the fragment or a missing trailing slash as a redirect", async () => {
    const result = await run(`${base}#/route`);
    expect(result.status).toBe("completed");
    expect(navigation(result)).toBe(`Navigate ${base}#/route (HTTP 200)`);
  });

  it("records the final URL of a redirect", async () => {
    const result = await run(`${base}/redirect`);
    expect(result.status).toBe("completed");
    expect(navigation(result)).toBe(
      `Navigate ${base}/redirect (HTTP 200, redirected to ${base}/ok)`,
    );
  });

  it.each([
    ["/missing", 404],
    ["/empty404", 404],
    ["/broken", 500],
  ])(
    "fails %s as product behavior with the operation and a failure image",
    async (path, status) => {
      const result = await run(`${base}${path}`);
      expect(result.status).toBe("failed");
      expect(result.failure?.kind).toBe("behavior");
      expect(result.failure?.message).toContain(`answered HTTP ${status}`);
      expect(navigation(result)).toBe(`Navigate ${base}${path} (HTTP ${status})`);
      expect(result.failure).toMatchObject({
        operationId: result.operations.find((operation) => operation.kind === "navigate")?.id,
      });
      expect(result.captures).toHaveLength(1);
    },
  );

  it("leaves a refused connection as the unchanged navigation error", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(run(`http://127.0.0.1:${port}/`)).rejects.toThrow("ERR_CONNECTION_REFUSED");
  });

  it.each(["#empty", "#dead"])(
    "does not accept Chrome's error page as a capture after clicking %s",
    async (selector) => {
      const journey = {
        url: `${base}/start`,
        actions: [{ kind: "click" as const, selector, capture: true }],
      };
      // A capture of chrome-error://chromewebdata/ still throws, as before; it never completes.
      await expect(
        runBrowserJourney({ directory, subjectDigest: "a".repeat(64), journey }),
      ).rejects.toThrow("HTTP(S)");
    },
  );
});
