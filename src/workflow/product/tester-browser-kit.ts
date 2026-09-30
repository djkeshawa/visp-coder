import { hasUiIntent } from "./request-promises.js";

/**
 * A browser kit for the tester's single test file (Node 22+, standard library only): a real
 * headless Chrome from CHROME_BIN, native mouse and touch input, and a teardown that never
 * throws. It prints nothing (never `FAIL:` or `PASS:`), adds no assertions and defines only
 * `BrowserUnavailable`, `serveDir` and `openPage`. It contains no backtick or template
 * placeholder so it can live in a raw template literal.
 */
export const TESTER_BROWSER_KIT = String.raw`// ---- VISP browser kit (Node 22+, standard library only): real Chrome, native input, safe teardown ----
// Prints nothing. Names it defines: BrowserUnavailable, serveDir, openPage. Do not redeclare them.
import * as kitCp from "node:child_process";
import * as kitFs from "node:fs";
import * as kitHttp from "node:http";
import * as kitOs from "node:os";
import * as kitPath from "node:path";

/** Chrome could not start or was lost: an environment problem, never a product failure. */
export class BrowserUnavailable extends Error {
  constructor(message) {
    super(String(message).replace(/\s+/g, " ").trim().slice(0, 500));
    this.name = "BrowserUnavailable";
  }
}
const kitSleep = (ms) => new Promise((done) => setTimeout(done, ms));
const kitWithin = (ms, work, label) => {
  let timer;
  return Promise.race([
    Promise.resolve(work).finally(() => clearTimeout(timer)),
    new Promise((_, no) => {
      timer = setTimeout(() => no(new Error(label + " timed out after " + ms + "ms")), ms);
    }),
  ]);
};

/**
 * Serve a directory over HTTP on a free loopback port. Returns { url, close }. Only regular files
 * whose real path is inside the directory are served (symlinks out of it give 404), and paths with
 * a dot segment (.env, .git) give 404 unless dotfiles is true. A directory serves its index.html.
 */
export async function serveDir(dir, { fallback = "index.html", dotfiles = false } = {}) {
  const root = kitFs.realpathSync(kitPath.resolve(dir));
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg" };
  const hidden = (path) => path.split(/[\\/]+/).some((part) => part === ".." || (!dotfiles && part.startsWith(".")));
  const server = kitHttp.createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.includes("\0") || hidden(path)) throw new Error("not served");
      let real = kitFs.realpathSync(kitPath.join(root, kitPath.normalize(path)));
      if (kitFs.statSync(real).isDirectory()) real = kitFs.realpathSync(kitPath.join(real, fallback));
      const inside = kitPath.relative(root, real);
      if (inside === "" || inside.startsWith("..") || kitPath.isAbsolute(inside) || hidden(inside)) throw new Error("outside root");
      if (!kitFs.statSync(real).isFile()) throw new Error("not a file");
      const body = kitFs.readFileSync(real);
      res.writeHead(200, { "content-type": types[kitPath.extname(real).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  server.unref();
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () => {
      try {
        server.closeAllConnections?.();
        server.close();
      } catch {}
    },
  };
}

// One shared registry ends every live Chrome when the process exits or is stopped by a signal
// (a suite that times out is sent SIGTERM; its Chrome is in its own process group).
const kitLive = new Set();
const kitHandlers = new Map();
const kitEndAll = () => { for (const end of kitLive) end(); };
const kitTrack = (end) => {
  kitLive.add(end);
  if (kitHandlers.size) return;
  kitHandlers.set("exit", kitEndAll);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    kitHandlers.set(signal, () => { kitEndAll(); kitUntrackAll(); process.kill(process.pid, signal); });
  }
  for (const [event, handler] of kitHandlers) process.on(event, handler);
};
const kitUntrackAll = () => { for (const [event, handler] of kitHandlers) process.removeListener(event, handler); kitHandlers.clear(); };
const kitUntrack = (end) => { kitLive.delete(end); if (!kitLive.size) kitUntrackAll(); };

/**
 * Open url in a fresh headless Chrome (real, native input). Throws BrowserUnavailable when Chrome
 * cannot start or connect; any other error means the page itself failed to load.
 */
export async function openPage(url, { width = 1280, height = 800, touch = false, timeoutMs = 20000 } = {}) {
  const binary = process.env.CHROME_BIN || "google-chrome";
  const profile = kitFs.mkdtempSync(kitPath.join(kitOs.tmpdir(), "acceptance-chrome-"));
  const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profile, "about:blank"];
  const child = kitCp.spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  let log = "";
  let socket;
  let closing;
  child.on("error", () => {});
  child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-600); });
  const exited = () => child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
  const killTree = (signal) => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
  };
  const removeProfile = () => { try { kitFs.rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {} };
  const onExit = () => { killTree("SIGKILL"); removeProfile(); };
  kitTrack(onExit);
  /** Never throws; safe to call any number of times, in finally. */
  const close = () => (closing ??= (async () => {
    try { socket?.close(); } catch {}
    if (!exited()) {
      const gone = new Promise((done) => child.once("exit", done));
      killTree("SIGTERM");
      await Promise.race([gone, kitSleep(1500)]);
      if (!exited()) { killTree("SIGKILL"); await Promise.race([gone, kitSleep(1000)]); }
    }
    kitUntrack(onExit);
    removeProfile();
  })().catch(() => {}));
  try {
    let send;
    const pending = new Map();
    try {
      const endpoint = await kitWithin(timeoutMs, new Promise((ok, no) => {
        child.once("error", (e) => no(new Error("cannot start " + binary + ": " + e.message)));
        child.once("close", () => no(new Error(binary + " exited before it was ready")));
        child.stderr.on("data", () => { const m = /DevTools listening on (ws:\/\/\S+)/.exec(log); if (m) ok(m[1]); });
      }), "Chrome startup");
      socket = new WebSocket(endpoint);
      await kitWithin(timeoutMs, new Promise((ok, no) => {
        socket.addEventListener("open", ok, { once: true });
        socket.addEventListener("error", () => no(new Error("cannot connect to Chrome")), { once: true });
      }), "Chrome connection");
      let nextId = 0;
      socket.addEventListener("message", ({ data }) => {
        const msg = JSON.parse(String(data));
        const entry = pending.get(msg.id);
        if (entry) { pending.delete(msg.id); if (msg.error) entry.no(new Error(msg.error.message)); else entry.ok(msg.result ?? {}); }
      });
      socket.addEventListener("close", () => {
        for (const entry of pending.values()) entry.no(closing ? new Error("page is closed") : new BrowserUnavailable("Chrome closed the connection"));
        pending.clear();
      });
      const call = (method, params = {}, sessionId) => kitWithin(10000, new Promise((ok, no) => {
        if (socket.readyState !== 1) return no(new Error("page is closed"));
        const id = ++nextId;
        pending.set(id, { ok, no });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }), method);
      const { targetId } = await call("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      send = (method, params) => call(method, params, sessionId);
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: touch });
      if (touch) await send("Emulation.setTouchEmulationEnabled", { enabled: true });
    } catch (cause) {
      if (cause instanceof BrowserUnavailable) throw cause;
      throw new BrowserUnavailable(binary + ": " + (cause instanceof Error ? cause.message : String(cause)) + (log ? " | " + log : ""));
    }
    const nav = await send("Page.navigate", { url });
    if (nav.errorText) throw new Error("cannot load " + url + ": " + nav.errorText);
    const page = {
      /** Run a function (or expression string) in the page; the result must be JSON-serializable. */
      async evaluate(code, ...args) {
        const expression = typeof code === "function" ? "(" + code + ")(..." + JSON.stringify(args) + ")" : String(code);
        const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      /** Wait until fn() (run in the page) returns truthy. Bounded. */
      async waitFor(fn, { timeoutMs: limit = 8000, everyMs = 50 } = {}) {
        const end = Date.now() + limit;
        for (;;) {
          try { const v = await page.evaluate(fn); if (v) return v; } catch (error) { if (error instanceof BrowserUnavailable) throw error; }
          if (Date.now() > end) throw new Error("waitFor timed out");
          await kitSleep(everyMs);
        }
      },
      /** Viewport CSS-pixel box of the first element matching selector. */
      rect: (selector) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error("no element " + s); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, selector),
      /** Viewport point at fractions (fx, fy) of an element's box, e.g. point("#game", 0.15, 0.7). */
      async point(selector, fx = 0.5, fy = 0.5) {
        const r = await page.rect(selector);
        return { x: r.x + r.width * fx, y: r.y + r.height * fy };
      },
      /** Native press-move-release (a finger when opened with touch: true). Calls held() while fully pulled, before release. */
      async drag(from, to, { steps = 12, stepMs = 16, held } = {}) {
        const mouse = (type, p, buttons) => send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons, clickCount: 1 });
        const finger = (type, points) => send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) });
        let at = from;
        if (touch) await finger("touchStart", [from]);
        else { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y }); await mouse("mousePressed", from, 1); }
        try {
          for (let i = 1; i <= steps; i++) {
            at = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
            await kitSleep(stepMs);
            if (touch) await finger("touchMove", [at]); else await mouse("mouseMoved", at, 1);
          }
          if (held) await held();
        } finally {
          if (touch) await finger("touchEnd", []); else await mouse("mouseReleased", at, 0);
        }
      },
      /** Native click or tap at a viewport point. */
      click: (p) => page.drag(p, p, { steps: 1, stepMs: 0 }),
      sleep: kitSleep,
      /** PNG as a Buffer; also written to path when given. */
      async screenshot(path) {
        const { data } = await send("Page.captureScreenshot", { format: "png" });
        const png = Buffer.from(data, "base64");
        if (path) kitFs.writeFileSync(path, png);
        return png;
      },
      close,
    };
    await page.waitFor(() => document.readyState === "complete", { timeoutMs });
    return page;
  } catch (cause) {
    await close();
    throw cause;
  }
}
// ---- end of VISP browser kit ----
`;

const BROWSER_RULES: readonly string[] = [
  "- Browser UI: the request describes something used in a browser. If the request only mentions HTML, CSS or a UI as file content or output and nothing is opened in a browser, ignore this bullet and the kit and use the normal rules. Otherwise write the file as Node.js (`*.acceptance.mjs`) and drive the real page with the kit below. Paste the kit unchanged at the top of your file; it is not one of your tests, adds no assertions, and its names (`BrowserUnavailable`, `serveDir`, `openPage`) must not be redeclared. Start the product the way the request says; when it only says index.html opens over HTTP, use `serveDir(process.cwd())`. `openPage(url, { width, height, touch })` starts a fresh headless Chrome and returns a page with `evaluate`, `waitFor`, `rect`, `point`, `drag`, `click`, `screenshot` and `close`. Interact only through native input (`page.point(selector, fx, fy)`, `page.drag(from, to, { held })`, `page.click(p)`) and read state through the interfaces the request names with `page.evaluate`. Never synthesize input with dispatchEvent, `new PointerEvent` or `element.click()`: that does not show that real input works. Never write your own Chrome, DevTools or `--dump-dom` code.",
  "- When you use the kit, choose real-input cases as a player would: press on the element the request says is pressed (search a small grid over its box for a start point where the drag changes state, bounded by iteration count), pull in at least two different directions, one with a vertical component, and assert only the direction (sign or quadrant) the request's convention implies. Use the viewports the request names, with `touch: true` for a phone.",
  "- When you use the kit: if `openPage` throws `BrowserUnavailable` (Chrome cannot start or was lost), that is an environment problem, not a product failure: re-throw it out of your per-test try/catch (print a `FAIL:` line only when `!(err instanceof BrowserUnavailable)`), stop running further tests, and print exactly one line `ENVIRONMENT ERROR: <err.message>` from your top-level handler, with no `FAIL:` line and no stack trace, then exit non-zero. Any other error (for example the page does not load) is that test's failure. Always `await page.close()` in a finally block and close servers you start; `close` never throws.",
];

/**
 * Tester-prompt lines for a request that describes something to see in a browser: the rules
 * and the kit source to paste into the test file. Nothing for any other request.
 */
export function testerBrowserKitLines(request: string): readonly string[] {
  if (!hasUiIntent(request)) return [];
  return [
    ...BROWSER_RULES,
    "",
    "Browser kit (Node.js ES module code; paste it unchanged at the top of the file):",
    "```js",
    TESTER_BROWSER_KIT.trim(),
    "```",
    "",
  ];
}
