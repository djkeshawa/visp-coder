import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { activateControl } from "../../src/testing/browser.js";
import { openBrowserSession } from "../../src/testing/browser-session.js";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/skyhook-scramble/index.html", import.meta.url),
);
it("distinguishes working touch input from invisible controls and tiny gameplay in the interrupted Skyhook run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-skyhook-feedback-"));
  const session = await openBrowserSession({
    subjectDigest: sha256(await readFile(fixture)),
    directory,
    fileRoot: dirname(fixture),
    viewport: { width: 390, height: 844 },
  });
  try {
    await session.navigate(pathToFileURL(fixture).href);
    await activateControl(session.page, "#launch-game", "pointer");
    const actual = await session.page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas");
      const reset = document.querySelector("#reset-level");
      const card = document.querySelector(".game-card");
      if (!canvas || !reset || !card) throw new Error("Missing game controls");
      const rect = canvas.getBoundingClientRect();
      return {
        rect: rect.toJSON(),
        birdWidth: (46 * rect.width) / canvas.width,
        foreground: getComputedStyle(reset).color,
        card: getComputedStyle(card).backgroundColor,
        label: reset.textContent,
      };
    }, undefined);
    expect(actual.label).toBe("Reset level");
    expect(actual.foreground).toBe(actual.card); // Presence/visibility checks would miss this defect.
    expect(actual.birdWidth).toBeLessThan(20);
    const r = actual.rect;
    await session.drag({
      input: "touch",
      from: { x: r.x + (205 * r.width) / 960, y: r.y + (398 * r.height) / 560 },
      to: { x: r.x + (100 * r.width) / 960, y: r.y + (450 * r.height) / 560 },
      steps: 14,
      durationMs: 350,
    });
    expect(
      await session.page.evaluate(
        () => document.querySelector<HTMLElement>("#game-shell")?.dataset.state,
        undefined,
      ),
    ).toBe("launched");
    expect((await readFile((await session.capture()).path)).byteLength).toBeGreaterThan(1000);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
  }
});
