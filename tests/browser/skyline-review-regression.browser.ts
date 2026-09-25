import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { activateControl } from "../../src/testing/browser.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

// Node 23.6 renamed --experimental-test-isolation; the package supports Node 22.16+.
const TEST_ISOLATION_NONE = process.allowedNodeEnvironmentFlags.has("--test-isolation")
  ? "--test-isolation=none"
  : "--experimental-test-isolation=none";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/skyline-review-regression/", import.meta.url),
);

// The original bytes remain frozen. The corrected timer variant is a countercheck
// for this regression, not a game-specific rule in VISP or a model quality result.
async function surface(corrected = false) {
  const files = new Map<string, Buffer>();
  for (const path of ["index.html", "styles.css", "src/main.mjs", "src/game-logic.mjs"])
    files.set(`/${path}`, await readFile(join(fixture, path)));
  if (corrected) {
    const original = files.get("/src/main.mjs")?.toString() ?? "";
    expect(original).toContain("window.setTimeout(() => {\n    refs.trail");
    files.set(
      "/src/main.mjs",
      Buffer.from(
        original
          .replace(
            "function animateLaunch(targetId, missileId) {",
            "let pendingLaunch;\nfunction animateLaunch(targetId, missileId) {",
          )
          .replace(
            "window.setTimeout(() => {\n    refs.trail",
            "pendingLaunch = window.setTimeout(() => {\n    refs.trail",
          )
          .replace(
            "function resetRound() {",
            "function resetRound() {\n  clearTimeout(pendingLaunch);\n  refs.trail.className = 'flight-trail';",
          ),
      ),
    );
  }
  const server = createServer((request, response) => {
    const path = request.url === "/" ? "/index.html" : (request.url ?? "");
    const bytes = files.get(path);
    response.writeHead(bytes ? 200 : 404, {
      // Keep frozen source bytes, but make behavioral regressions independent of
      // the fixture's Google Fonts import and external network availability.
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'",
      "Content-Type": path.endsWith(".mjs")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
    response.end(bytes ?? "Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local test port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

it("preserves the run's original source identity and demonstrates its eight weak tests still pass", async () => {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  for (const [path, expected] of Object.entries(manifest.sha256))
    expect(sha256(await readFile(join(fixture, path)))).toBe(expected);
  const output = execFileSync(
    process.execPath,
    ["--test", TEST_ISOLATION_NONE, "tests/game-logic.test.mjs"],
    { cwd: fixture, encoding: "utf8" },
  );
  expect(output).toMatch(/(?:pass 8|8 pass)/);
});

it.each([false, true])(
  "observes reset during flight on the frozen game (corrected timer: %s)",
  async (corrected) => {
    const site = await surface(corrected);
    const directory = await mkdtemp(join(tmpdir(), "visp-skyline-"));
    const session = await openBrowserSession({
      subjectDigest: sha256(corrected ? "corrected" : "original"),
      directory,
      viewport: { width: 1280, height: 800 },
    });
    try {
      await session.navigate(site.url);
      await activateControl(session.page, '[data-target-id="0"]', "pointer");
      await session.page.keyboard.press("r");
      const remaining = () =>
        session.page.evaluate(
          () => document.querySelector("#targets-remaining")?.textContent,
          undefined,
        );
      // Wait beyond the old asynchronous operation; no game state injection.
      await session.page.evaluate(
        () => new Promise<void>((resolve) => setTimeout(resolve, 900)),
        undefined,
      );
      const text = await remaining();
      expect(text).toBe(corrected ? "12 / 12" : "11 / 12");
      const capture = await session.capture();
      expect((await readFile(capture.path)).byteLength).toBeGreaterThan(1000);
    } finally {
      await session.close();
      await site.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("measures the primary targets below the phone viewport without interpreting screenshots as approval", async () => {
  const site = await surface();
  const directory = await mkdtemp(join(tmpdir(), "visp-skyline-phone-"));
  const session = await openBrowserSession({
    subjectDigest: sha256("original"),
    directory,
    viewport: { width: 390, height: 844 },
  });
  try {
    await session.navigate(site.url);
    const measured = await session.page.evaluate(
      () => ({
        viewportHeight: innerHeight,
        targetTop: document.querySelector('[data-target-id="0"]')?.getBoundingClientRect().top,
        pageHeight: document.documentElement.scrollHeight,
      }),
      undefined,
    );
    expect(measured.targetTop).toBeGreaterThan(measured.viewportHeight);
    expect(measured.pageHeight).toBeGreaterThan(measured.viewportHeight);
    expect((await session.capture()).viewport).toEqual({ width: 390, height: 844 });
  } finally {
    await session.close();
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});
