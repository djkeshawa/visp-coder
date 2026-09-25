import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { activateControl } from "../../src/testing/browser.js";
import { measureCanvasRegion } from "../../src/testing/canvas.js";
import { assertTransitions } from "../../src/testing/transitions.js";
import { openChrome } from "./support/chrome.js";

let browser: Awaited<ReturnType<typeof openChrome>>;
beforeAll(async () => {
  browser = await openChrome();
});
afterAll(async () => {
  await browser?.close();
});

it("a real rendered blast check detects a destroyed target outside the ring despite a passing weak launch check", async () => {
  const fixture = await readFile(
    new URL("../fixtures/product-quality/blast.html", import.meta.url),
    "utf8",
  );
  for (const repaired of [false, true]) {
    await browser.setContent(
      repaired ? fixture.replace("<body>", '<body class="repaired">') : fixture,
      1280,
      800,
    );
    const sample = async () => ({
      ammo: await browser.page.evaluate(
        () => Number(document.querySelector("#ammo")?.textContent),
        undefined,
      ),
      targetPixels: (
        await browser.page.evaluate(measureCanvasRegion, {
          selector: "#range",
          x: 412,
          y: 121,
          width: 8,
          height: 8,
          color: [255, 202, 112, 255],
        })
      ).matchingPixels,
    });
    // The target is 163px from the aim; the ring radius is 71px and target half-width 24px.
    // Observe the rendered target rather than inspecting the application's hit-test function.
    const transition = assertTransitions({
      label: "blast agrees with visible geometry",
      sample,
      steps: [
        {
          name: "target outside blast remains visible",
          act: () => activateControl(browser.page, "#launch", "pointer"),
          verify: (before, after) => before.targetPixels === 64 && after.targetPixels === 64,
        },
      ],
    });
    if (repaired) await expect(transition).resolves.toHaveLength(1);
    else await expect(transition).rejects.toThrow("outside blast");
    // This genuinely executed assertion passes in both versions and cannot prove blast correctness.
    expect((await sample()).ammo).toBe(1);
  }
});
