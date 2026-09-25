import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { activateControl } from "../../src/testing/browser.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

it("records the first rendered down-right motion after a real down-left Fowl Play pull", async () => {
  const fixture = fileURLToPath(
    new URL("../fixtures/product-quality/fowl-play-review-regression/index.html", import.meta.url),
  );
  const directory = await mkdtemp(join(tmpdir(), "visp-fowl-play-"));
  const session = await openBrowserSession({
    subjectDigest: sha256(await readFile(fixture)),
    directory,
    fileRoot: dirname(fixture),
    viewport: { width: 1280, height: 720 },
  });
  try {
    await session.navigate(pathToFileURL(fixture).href);
    await activateControl(session.page, "#startButton", "pointer");
    await session.page.evaluate(() => {
      const translate = CanvasRenderingContext2D.prototype.translate;
      const samples: number[][] = [];
      (window as unknown as { launchSamples: number[][] }).launchSamples = samples;
      CanvasRenderingContext2D.prototype.translate = function (x, y) {
        // Only the bird translates in this region after launch; retain its first frames
        // before a ground bounce can hide the sign error. Original rendering still runs.
        if (
          document.querySelector<HTMLElement>("#gameCanvas")?.dataset.state === "flight" &&
          x > 112 &&
          x < 250 &&
          y > 500 &&
          samples.length < 4
        )
          samples.push([x, y]);
        translate.call(this, x, y);
      };
    }, undefined);
    let heldImage: string | undefined;
    await session.drag(
      {
        from: { x: 184, y: 550 },
        to: { x: 112, y: 570 },
        input: "pointer",
        steps: 8,
        durationMs: 240,
      },
      async () => {
        heldImage = (await session.capture()).path;
      },
    );
    const released = await session.capture();
    const samples = await session.page.evaluate(
      () => (window as unknown as { launchSamples: number[][] }).launchSamples,
      undefined,
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]?.[0]).toBeGreaterThan(112);
    expect(samples[0]?.[1]).toBeGreaterThan(570);
    expect((await readFile(released.path)).byteLength).toBeGreaterThan(1000);
    expect(heldImage).toBeDefined();
    expect(session.operations.filter((entry) => entry.kind === "capture")).toHaveLength(2);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
