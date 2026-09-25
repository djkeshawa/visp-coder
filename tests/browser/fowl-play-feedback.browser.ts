import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { measureControl } from "../../src/testing/browser.js";
import { waitForObservation } from "../../src/testing/browser-observations.js";
import { type BrowserSession, openBrowserSession } from "../../src/testing/browser-session.js";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/fowl-play.html", import.meta.url),
);
const originalHash = "117d7d53cc1e504bc477c975ded5ffc85db45f7884320dba3bbff2ef22e41e8e";
async function withGame(
  corrected: boolean,
  check: (session: BrowserSession) => Promise<void>,
  viewport = { width: 1280, height: 800 },
) {
  const original = await readFile(fixture, "utf8");
  expect(sha256(original)).toBe(originalHash);
  const root = await mkdtemp(join(tmpdir(), "visp-fowl-countercheck-"));
  let source = original;
  if (corrected)
    source = source
      .replace(
        '} else if (game.impactTime > 1.9 && game.shotsLeft === 0) {\n            setPhase("win");',
        '} else if (game.impactTime > 1.9 && game.shotsLeft === 0) {\n            setPhase("lost");',
      )
      .replace(
        'game.phase = "ready";\n        game.score',
        'game.phase = "ready";\n        root.dataset.state = "ready";\n        game.score',
      )
      .replace("(point.x - anchor.x) * 0.068", "(anchor.x - point.x) * 0.068")
      .replace("(point.y - anchor.y) * 0.068", "(anchor.y - point.y) * 0.068");
  await writeFile(join(root, "game.html"), source);
  const session = await openBrowserSession({
    subjectDigest: sha256(source),
    directory: join(root, "captures"),
    fileRoot: root,
    viewport,
  });
  try {
    await session.navigate(pathToFileURL(join(root, "game.html")).href);
    await check(session);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function phase(session: BrowserSession, state: string) {
  await waitForObservation(
    session,
    { selector: "#game-root", attribute: { name: "data-state", value: state }, timeoutMs: 9000 },
    AbortSignal.timeout(10000),
  );
}

it.each([false, true])(
  "counterchecks exhausted shots and native R reset (corrected=%s)",
  async (corrected) => {
    await withGame(corrected, async (session) => {
      await session.page.keyboard.press("Enter");
      for (let shot = 0; shot < 3; shot++) {
        await phase(session, "playing");
        await session.page.keyboard.press("Space");
        await phase(session, "impact");
      }
      await phase(session, corrected ? "lost" : "win");
      const result = await session.page.evaluate(
        () => ({
          targets: document.querySelector("#target-value")?.textContent,
          state: document.querySelector("#game-root")?.getAttribute("data-state"),
        }),
        undefined,
      );
      expect(result.targets).toBe("3 / 3");
      expect(result.state === "win").toBe(!corrected);
      await session.page.keyboard.press("r");
      const reset = await session.page.evaluate(
        () => document.querySelector("#game-root")?.getAttribute("data-state"),
        undefined,
      );
      expect(reset).toBe(corrected ? "ready" : "win");
      expect(session.operations.filter((entry) => entry.kind === "keyboard")).toHaveLength(5);
    });
  },
);

it.each([false, true])(
  "counterchecks pull-back direction using rendered pixels (corrected=%s)",
  async (corrected) => {
    await withGame(corrected, async (session) => {
      await session.page.keyboard.press("Enter");
      const anchor = await session.page.evaluate(() => {
        const rect = document.querySelector("canvas")?.getBoundingClientRect();
        if (!rect) throw new Error("Missing canvas");
        return { x: rect.x + rect.width * 0.16, y: rect.y + rect.height * 0.82 - 13 };
      }, undefined);
      await paintedFrame(session);
      const initialX = await session.page.evaluate(coralCentroid, undefined);
      if (initialX === null) throw new Error("Missing rendered bird before launch");
      await session.drag({
        from: anchor,
        to: { x: anchor.x - 90, y: anchor.y + 30 },
        input: "pointer",
        steps: 8,
        durationMs: 80,
      });
      await phase(session, "flying");
      await paintedFrame(session);
      const deadline = Date.now() + 1500;
      let x = await session.sample(coralCentroid, undefined);
      while ((x === null || Math.abs(x - initialX) < 12) && Date.now() < deadline) {
        await pause(20);
        x = await session.sample(coralCentroid, undefined);
      }
      if (x === null) throw new Error("Bird pixels disappeared before direction could be observed");
      session.record("observe", "Pull-back launch direction", {
        initialX,
        observedX: x,
        expected: "right",
        matched: x > initialX,
      });
      expect(Math.abs(x - initialX)).toBeGreaterThanOrEqual(12);
      expect(x > initialX, JSON.stringify({ initialX, x, corrected })).toBe(corrected);
      await session.capture();
    });
  },
);

it("keeps the mobile primary-control gap visible even though desktop checks pass", async () => {
  await withGame(
    false,
    async (session) => {
      const start = await session.page.evaluate(measureControl, "#start-button");
      expect(start.y).toBeGreaterThan(844);
      await session.capture();
    },
    { width: 390, height: 844 },
  );
});

function coralCentroid() {
  const canvas = document.querySelector("canvas");
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) throw new Error("Missing canvas pixels");
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let sum = 0,
    count = 0;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width * 0.4; x++) {
      const i = (y * canvas.width + x) * 4;
      if (pixels[i] === 251 && pixels[i + 1] === 118 && pixels[i + 2] === 91) {
        sum += x;
        count++;
      }
    }
  return count ? sum / count : null;
}

async function paintedFrame(session: BrowserSession) {
  await session.page.evaluate(
    () =>
      new Promise<number>((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    undefined,
  );
}
