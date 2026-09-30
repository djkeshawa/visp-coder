import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confineBrowserFiles, readBrowserFile } from "../../../src/testing/browser-files.js";
import type { ChromeTransport } from "../../../src/testing/chrome-transport.js";

const race = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | (() => void),
  afterRecheck: undefined as undefined | (() => void),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // The reader's own calls only: open before the read, and the bigint lstat of a path recheck.
    open: ((...args: Parameters<typeof actual.open>) => {
      race.beforeOpen?.();
      return actual.open(...args);
    }) as typeof actual.open,
    lstat: (async (...args: Parameters<typeof actual.lstat>) => {
      const stats = await actual.lstat(...args);
      if ((args[1] as { bigint?: boolean } | undefined)?.bigint) race.afterRecheck?.();
      return stats;
    }) as typeof actual.lstat,
  };
});
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-file-reader-"));
  await writeFile(join(root, "index.html"), "<html>Safe bytes</html>");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const url = (path: string) => pathToFileURL(path).href;
it("serves real project bytes with a media type", async () => {
  expect(await readBrowserFile(root, url(join(root, "index.html")))).toMatchObject({
    type: "text/html",
  });
  expect(
    Buffer.from(
      (await readBrowserFile(root, url(join(root, "index.html")))).bytes ?? [],
    ).toString(),
  ).toBe("<html>Safe bytes</html>");
  await writeFile(join(root, "other.bin"), "binary");
  expect((await readBrowserFile(root, url(join(root, "other.bin")))).type).toBe(
    "application/octet-stream",
  );
});
it("rejects traversal, encoded separators, remote file hosts and directory/symlink inputs", async () => {
  await symlink(join(root, "index.html"), join(root, "linked.html"));
  await symlink(root, join(root, "linked-dir"));
  for (const input of [
    "https://example.com",
    url(join(root, "..", "outside.html")),
    url(root),
    url(join(root, "linked.html")),
    url(join(root, "linked-dir", "index.html")),
    `${url(root)}/a%2Fb`,
    "file://remotehost/share/index.html",
  ])
    await expect(readBrowserFile(root, input)).rejects.toThrow();
});
it("returns a missing confined asset for an HTTP-style 404 response", async () => {
  expect(await readBrowserFile(root, url(join(root, "missing.png")))).toMatchObject({
    bytes: null,
    type: "image/png",
  });
});
it("rejects configured and default blocked paths and oversized inputs", async () => {
  await writeFile(join(root, ".env"), "not public");
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "not public");
  for (const name of [".env", ".git/config"])
    await expect(readBrowserFile(root, url(join(root, name)))).rejects.toThrow(
      /allowed project content/,
    );
  await expect(readBrowserFile(root, url(join(root, "index.html")), ["*.html"])).rejects.toThrow(
    /allowed project content/,
  );
  await truncate(join(root, "index.html"), 33 * 1024 * 1024);
  await expect(readBrowserFile(root, url(join(root, "index.html")))).rejects.toThrow(/32 MiB/);
});
it("never returns bytes from a file swapped for a link between the check and the read", async () => {
  const outside = await mkdtemp(join(tmpdir(), "visp-file-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET");
    await writeFile(join(root, ".env"), "ENV-SECRET");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "page.html"), "PUBLIC");
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "page.html"), "DIST-SECRET");
    const page = join(root, "page.html");
    await writeFile(page, "PUBLIC");
    let stop = false;
    const swapper = (async () => {
      for (let i = 0; !stop; i += 1) {
        const scratch = join(root, `swap-${i % 2}`);
        try {
          await rm(scratch, { force: true, recursive: true });
          if (i % 4 === 0) await symlink(join(outside, "secret.txt"), scratch);
          else if (i % 4 === 1) await symlink(join(root, ".env"), scratch);
          else await writeFile(scratch, "PUBLIC");
          await rename(scratch, page);
          // The directory component is swapped as well: sub -> dist (a blocked in-root directory).
          const dir = join(root, `dir-${i % 2}`);
          await rm(dir, { force: true, recursive: true });
          if (i % 2 === 0) await symlink(join(root, "dist"), dir);
          else await mkdir(dir);
          await rename(dir, join(root, "sub-swap")).catch(() => {});
        } catch {
          // A racing rename may fail; the reader is what is under test.
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    let leaks = 0;
    let reads = 0;
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      for (const target of [page, join(root, "sub-swap", "page.html")]) {
        try {
          const loaded = await readBrowserFile(root, url(target));
          reads += 1;
          if (/SECRET/.test(Buffer.from(loaded.bytes ?? []).toString())) leaks += 1;
        } catch {
          // Refusing a swapped file is the correct outcome.
        }
      }
    }
    stop = true;
    await swapper;
    expect(reads).toBeGreaterThan(0);
    expect(leaks).toBe(0);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it("never reads through a parent directory swapped for a link to outside or to .git", async () => {
  const outside = await mkdtemp(join(tmpdir(), "visp-parent-outside-"));
  try {
    await mkdir(join(outside, "d"));
    await writeFile(join(outside, "d", "page.html"), "OUTSIDE-SECRET");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "page.html"), "GIT-SECRET");
    const dir = join(root, "d");
    await mkdir(dir);
    await writeFile(join(dir, "page.html"), "PUBLIC");
    let stop = false;
    let round = 0;
    const swapper = (async () => {
      while (!stop) {
        // Synchronous steps keep the window between them as small as an attacker's would be.
        try {
          if (round++ % 2 === 0) {
            const scratch = join(root, "d.tmp");
            symlinkSync(round % 4 === 1 ? join(outside, "d") : join(root, ".git"), scratch);
            rmSync(dir, { recursive: true });
            renameSync(scratch, dir);
          } else {
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir);
            writeFileSync(join(dir, "page.html"), "PUBLIC");
          }
        } catch {
          // A racing step may fail; the reader is what is under test.
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    let leaks = 0;
    let reads = 0;
    const readOnce = async () => {
      try {
        const loaded = await readBrowserFile(root, url(join(dir, "page.html")));
        reads += 1;
        if (/SECRET/.test(Buffer.from(loaded.bytes ?? []).toString())) leaks += 1;
      } catch {
        // Refusing a swapped parent is the correct outcome.
      }
    };
    const until = Date.now() + 3000;
    while (Date.now() < until) await Promise.all(Array.from({ length: 4 }, readOnce));
    stop = true;
    await swapper;
    expect(reads).toBeGreaterThan(0);
    expect(leaks).toBe(0);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "linux")(
  "refuses a file opened through a parent that was a link when opened, even if the path looks right again",
  async () => {
    const outside = await mkdtemp(join(tmpdir(), "visp-parent-race-"));
    try {
      await mkdir(join(outside, "d"));
      await writeFile(join(outside, "d", "page.html"), "OUTSIDE-SECRET");
      const dir = join(root, "d");
      const realDirectory = () => {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
        writeFileSync(join(dir, "page.html"), "PUBLIC");
      };
      realDirectory();
      // The check passes on a real directory; the directory is a link to outside when the file is
      // opened, and is a real directory again by the time the path is looked at afterwards.
      race.beforeOpen = () => {
        rmSync(dir, { recursive: true, force: true });
        symlinkSync(join(outside, "d"), dir);
      };
      race.afterRecheck = () => {
        race.afterRecheck = undefined;
        rmSync(dir, { force: true });
        mkdirSync(dir);
        writeFileSync(join(dir, "page.html"), "PUBLIC");
      };
      const read = readBrowserFile(root, url(join(dir, "page.html"))).then(
        (loaded) => Buffer.from(loaded.bytes ?? []).toString(),
        () => "refused",
      );
      expect(await read).not.toContain("SECRET");
    } finally {
      race.beforeOpen = undefined;
      race.afterRecheck = undefined;
      await rm(outside, { recursive: true, force: true });
    }
  },
);
it("refuses a file with more than one hard link (an alias of a blocked file)", async () => {
  await writeFile(join(root, ".env"), "ENV-SECRET");
  await link(join(root, ".env"), join(root, "innocent.html"));
  await expect(readBrowserFile(root, url(join(root, "innocent.html")))).rejects.toThrow(
    /single-link/,
  );
});
it("applies the blocked paths when the root is spelled through a symlink", async () => {
  const alias = `${root}-alias`;
  await symlink(root, alias);
  try {
    await writeFile(join(root, ".env"), "ENV-SECRET");
    await expect(readBrowserFile(alias, url(join(alias, ".env")))).rejects.toThrow(
      /allowed project content/,
    );
    expect(
      Buffer.from(
        (await readBrowserFile(alias, url(join(alias, "index.html")))).bytes ?? [],
      ).toString(),
    ).toBe("<html>Safe bytes</html>");
    expect(await realpath(alias)).toBe(await realpath(root));
  } finally {
    await rm(alias, { force: true });
  }
});
function transportFixture() {
  let emit: Parameters<ChromeTransport["onEvent"]>[0] = () => {};
  const dispose = vi.fn();
  const transport: ChromeTransport = {
    send: vi.fn(async () => ({ targetInfos: [{ targetId: "initial", url: "about:blank" }] })),
    close: vi.fn(),
    onEvent(listener) {
      emit = listener;
      return dispose;
    },
  };
  const send = Object.assign(
    vi.fn(async () => ({})),
    { sessionId: "main-session", targetId: "main" },
  );
  return {
    transport,
    send,
    dispose,
    emit: (method: string, params: Record<string, unknown>, sessionId = "main-session") =>
      emit({ method, params, sessionId }),
  };
}
it("fulfills confined requests with owned bytes and fails forbidden requests", async () => {
  const f = transportFixture();
  const policy = await confineBrowserFiles(f.transport, f.send, root);
  f.emit("unrelated", {});
  f.emit("Fetch.requestPaused", {}, "other-session");
  f.emit("Fetch.requestPaused", {
    requestId: "ok",
    request: { url: url(join(root, "index.html")), method: "GET" },
  });
  await policy.check();
  expect(f.send).toHaveBeenCalledWith(
    "Fetch.fulfillRequest",
    expect.objectContaining({
      requestId: "ok",
      body: Buffer.from("<html>Safe bytes</html>").toString("base64"),
    }),
  );
  f.emit("Fetch.requestPaused", {
    requestId: "bad",
    request: { url: url(join(root, "index.html")), method: "POST" },
  });
  await expect(policy.check()).rejects.toThrow(/GET only/);
  expect(f.send).toHaveBeenCalledWith("Fetch.failRequest", {
    requestId: "bad",
    errorReason: "BlockedByClient",
  });
  policy.dispose();
  expect(f.dispose).toHaveBeenCalledOnce();
});
it("fulfills missing assets as 404 without a browser security gap", async () => {
  const f = transportFixture();
  const policy = await confineBrowserFiles(f.transport, f.send, root);
  f.emit("Fetch.requestPaused", {
    requestId: "missing",
    request: { url: url(join(root, "missing.png")), method: "GET" },
  });
  await policy.check();
  expect(f.send).toHaveBeenCalledWith(
    "Fetch.fulfillRequest",
    expect.objectContaining({ requestId: "missing", responseCode: 404 }),
  );
});
it("stops new blank popups while ignoring Chrome-owned surfaces and the controlled page", async () => {
  const f = transportFixture();
  const policy = await confineBrowserFiles(f.transport, f.send, root);
  for (const targetInfo of [
    {},
    { targetId: "main" },
    { targetId: "initial" },
    { targetId: "ui", type: "browser_ui" },
    { targetId: "background", type: "background_page" },
    { targetId: "extension", url: "chrome-extension://builtin/worker.js" },
  ])
    f.emit("Target.attachedToTarget", { targetInfo });
  await policy.check();
  f.emit("Target.attachedToTarget", {
    targetInfo: { targetId: "popup", url: "about:blank", type: "page" },
  });
  await expect(policy.check()).rejects.toThrow(/extra browsing targets/);
  expect(f.transport.send).toHaveBeenCalledWith("Target.closeTarget", { targetId: "popup" });
});
it("reports transport failure and removes its listener if setup fails", async () => {
  const f = transportFixture();
  f.send.mockRejectedValueOnce(new Error("interception unsupported"));
  await expect(confineBrowserFiles(f.transport, f.send, root)).rejects.toThrow(/unsupported/);
  expect(f.dispose).toHaveBeenCalledOnce();
  const policy = await confineBrowserFiles(f.transport, f.send, root);
  f.send.mockRejectedValue(new Error("disconnected"));
  f.emit("Fetch.requestPaused", {
    requestId: "bad",
    request: { url: url(join(root, "index.html")), method: "GET" },
  });
  await expect(policy.check()).rejects.toThrow(/disconnected/);
});

it("keeps browser security failures explicit while ignoring ordinary log entries", async () => {
  const f = transportFixture();
  const policy = await confineBrowserFiles(f.transport, f.send, root);
  f.emit("Log.entryAdded", { entry: { source: "javascript", level: "error" } });
  f.emit("Log.entryAdded", { entry: { source: "security", level: "warning" } });
  await policy.check();
  f.emit("Log.entryAdded", { entry: { source: "security", level: "error" } });
  await expect(policy.check()).rejects.toThrow(/security policy/);
});
