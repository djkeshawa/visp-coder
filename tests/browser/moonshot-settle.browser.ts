import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { activateControl, assertControlReachable } from "../../src/testing/browser.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

// Node 23.6 renamed --experimental-test-isolation; the package supports Node 22.16+.
const TEST_ISOLATION_NONE = process.allowedNodeEnvironmentFlags.has("--test-isolation")
  ? "--test-isolation=none"
  : "--experimental-test-isolation=none";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/moonshot-settle/", import.meta.url),
);
it.each([false, true])(
  "observes settlement and recovery beyond passing weak checks (corrected=%s)",
  async (corrected) => {
    const directory = await mkdtemp(join(tmpdir(), "visp-moonshot-"));
    await cp(fixture, directory, { recursive: true });
    const source = join(directory, "game.js");
    if (corrected)
      await writeFile(
        source,
        (await readFile(source, "utf8")).replace(
          "if (state.phase === 'flight') updateProjectiles(deltaTime);",
          "if (state.phase === 'flight' || state.phase === 'settle') updateProjectiles(deltaTime);",
        ),
      );
    const unit = execFileSync(
      process.execPath,
      ["--test", TEST_ISOLATION_NONE, "--test-reporter=tap", "tests/game-core.test.mjs"],
      { cwd: directory, encoding: "utf8" },
    );
    expect(unit).toContain("# fail 0");
    const session = await openBrowserSession({
      subjectDigest: sha256(await readFile(source)),
      directory,
      fileRoot: directory,
      viewport: { width: 1280, height: 900 },
    });
    try {
      await session.navigate(pathToFileURL(join(directory, "index.html")).href);
      await activateControl(session.page, "#startButton", "pointer");
      const bounds = await session.page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas) throw new Error("Missing canvas");
        return canvas.getBoundingClientRect().toJSON();
      }, undefined);
      const launch = () =>
        session.drag({
          from: {
            x: bounds.x + (158 * bounds.width) / 1200,
            y: bounds.y + (470 * bounds.height) / 640,
          },
          to: {
            x: bounds.x + (220 * bounds.width) / 1200,
            y: bounds.y + (500 * bounds.height) / 640,
          },
          input: "pointer",
          steps: 8,
          durationMs: 180,
        });
      await launch();
      const phase = () =>
        session.page.evaluate(
          () => document.querySelector<HTMLElement>("#gameCanvas")?.dataset.state,
          undefined,
        );
      expect(await phase()).toBe("flight"); // The original browser check ends here.
      const waitForPhase = async (expected: string) => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && (await phase()) !== expected)
          await new Promise((r) => setTimeout(r, 100));
        expect(await phase()).toBe(expected);
      };
      if (!corrected) {
        await waitForPhase("settle");
        await new Promise((r) => setTimeout(r, 1200));
        expect(await phase()).toBe("settle");
        expect(
          await session.page.evaluate(
            () => document.querySelector("#liveMessage")?.textContent,
            undefined,
          ),
        ).toContain("settling");
      } else {
        await waitForPhase("ready");
        for (let shot = 0; shot < 3; shot++) {
          await launch();
          await waitForPhase(shot === 2 ? "lost" : "ready");
        }
        // The loss state precedes the panel's CSS fade-in; wait for the actual
        // control to become reachable rather than assuming state implies visibility.
        await waitForRetry(session.page);
        await activateControl(session.page, "#startButton", "pointer");
        await waitForPhase("ready");
        expect(
          await session.page.evaluate(
            () => document.querySelector("#birdsValue")?.textContent,
            undefined,
          ),
        ).toContain("4");
      }
      expect((await readFile((await session.capture()).path)).byteLength).toBeGreaterThan(1000);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  65000,
);

async function waitForRetry(page: Awaited<ReturnType<typeof openBrowserSession>>["page"]) {
  const visibleDeadline = Date.now() + 3000;
  while (true) {
    try {
      await assertControlReachable(page, "#startButton");
      break;
    } catch (error) {
      if (Date.now() >= visibleDeadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
