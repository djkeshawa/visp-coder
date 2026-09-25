import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { confineBrowserFiles, readBrowserFile } from "../../../src/testing/browser-files.js";
import type { ChromeTransport } from "../../../src/testing/chrome-transport.js";

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
    Buffer.from((await readBrowserFile(root, url(join(root, "index.html")))).bytes).toString(),
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
    url(join(root, "missing")),
    url(join(root, "linked.html")),
    url(join(root, "linked-dir", "index.html")),
    `${url(root)}/a%2Fb`,
    "file://remotehost/share/index.html",
  ])
    await expect(readBrowserFile(root, input)).rejects.toThrow();
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
