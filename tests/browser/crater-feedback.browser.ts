import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/crater-critters/index.html", import.meta.url),
);
it("shows that successful mobile touch execution does not establish undistorted or comfortably sized artwork", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-crater-feedback-"));
  const subjectDigest = sha256(await readFile(fixture));
  const session = await openBrowserSession({
    subjectDigest,
    directory,
    fileRoot: dirname(fixture),
    viewport: { width: 390, height: 844 },
  });
  try {
    await session.navigate(pathToFileURL(fixture).href);
    const geometry = await session.page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas");
      if (!canvas) throw new Error("Missing canvas");
      const box = canvas.getBoundingClientRect();
      return {
        distortion: box.width / canvas.width / (box.height / canvas.height),
        birdWidth: (44 * box.width) / canvas.width,
      };
    }, undefined);
    expect(geometry.distortion).toBeLessThan(0.5);
    expect(geometry.birdWidth).toBeLessThan(20);
    await session.drag({
      input: "touch",
      from: { x: 76, y: 540 },
      to: { x: 32, y: 610 },
      steps: 14,
      durationMs: 360,
    });
    expect(
      await session.page.evaluate(() => document.querySelector("#shots")?.textContent, undefined),
    ).toBe("04");
    const capture = await session.capture();
    expect((await readFile(capture.path)).byteLength).toBeGreaterThan(1000);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
