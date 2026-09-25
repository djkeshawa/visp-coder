import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

it("observes a real flying bird while the renderer still draws stretched sling bands", async () => {
  const fixture = fileURLToPath(
    new URL("../fixtures/product-quality/flockshot-release-regression/index.html", import.meta.url),
  );
  const directory = await mkdtemp(join(tmpdir(), "visp-flockshot-"));
  const session = await openBrowserSession({
    subjectDigest: sha256(await readFile(fixture)),
    directory,
    fileRoot: dirname(fixture),
    viewport: { width: 1280, height: 720 },
  });
  try {
    await session.navigate(pathToFileURL(fixture).href);
    await session.page.evaluate(() => {
      const original = CanvasRenderingContext2D.prototype.lineTo;
      const samples: number[][] = [];
      (window as unknown as { bandSamples: number[][] }).bandSamples = samples;
      CanvasRenderingContext2D.prototype.lineTo = function (x, y) {
        if (this.strokeStyle === "#e8b26c") {
          samples.push([x, y]);
          if (samples.length > 10) samples.shift();
        }
        original.call(this, x, y);
      };
    }, undefined);
    await session.page.mouse.click(514, 368);
    await session.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const deadline = performance.now() + 4000;
          const observe = () => {
            const bands = (window as unknown as { bandSamples: number[][] }).bandSamples;
            if (bands.some(([x]) => x !== undefined && x > 250) || performance.now() >= deadline)
              resolve();
            else requestAnimationFrame(observe);
          };
          observe();
        }),
      undefined,
    );
    const actual = await session.page.evaluate(
      () => ({
        state: document.querySelector<HTMLElement>("#game")?.dataset.state,
        bands: (window as unknown as { bandSamples: number[][] }).bandSamples,
      }),
      undefined,
    );
    expect(actual.state).toBe("flying");
    expect(actual.bands.some(([x]) => x !== undefined && x > 250)).toBe(true);
    expect((await readFile((await session.capture()).path)).byteLength).toBeGreaterThan(1000);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
