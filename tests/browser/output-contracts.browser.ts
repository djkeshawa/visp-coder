import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { measureCanvasRegion } from "../../src/testing/canvas.js";
import { assertBehaviorSensitive, assertTransitions } from "../../src/testing/transitions.js";
import { openChrome } from "./support/chrome.js";

let browser: Awaited<ReturnType<typeof openChrome>>;
let fixture: string;
beforeAll(async () => {
  browser = await openChrome();
  fixture = await readFile(
    new URL("../fixtures/product-quality/output.html", import.meta.url),
    "utf8",
  );
});
afterAll(async () => browser?.close());

async function subject(variant: string) {
  await browser.setContent(fixture.replace("<body>", `<body class="${variant}">`), 640, 480);
  return browser.page;
}

it("kills a blank-renderer mutant even when its DOM success message still passes", async () => {
  await assertBehaviorSensitive({
    label: "rendered result",
    baseline: () => subject(""),
    changed: () => subject("no-render"),
    verify: async (page) => {
      await page.mouse.click(45, 18);
      expect(
        await page.evaluate(() => document.querySelector("#status")?.textContent, undefined),
      ).toBe("rendered");
      const pixels = await page.evaluate(measureCanvasRegion, {
        selector: "#scene",
        x: 120,
        y: 20,
        width: 40,
        height: 40,
        color: [0, 255, 0, 255],
      });
      return pixels.matchingRatio === 1;
    },
  });
});

it("detects a detached connector during a held gesture although both endpoints look correct", async () => {
  for (const variant of ["", "detached"]) {
    await subject(variant);
    const sample = () =>
      browser.page.evaluate(measureCanvasRegion, {
        selector: "#scene",
        x: 20,
        y: 80,
        width: 100,
        height: 4,
        color: [255, 0, 0, 255],
      });
    const action = async () => {
      await browser.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 60,
        y: 90,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 120));
      } finally {
        await browser.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 60,
          y: 90,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      }
    };
    // The old endpoint-only check demonstrably misses this mutant.
    await expect(
      assertTransitions({
        label: "endpoints",
        sample,
        steps: [
          {
            name: "hold",
            act: action,
            verify: (before, after) => before.matchingRatio === 1 && after.matchingRatio === 1,
          },
        ],
      }),
    ).resolves.toHaveLength(1);
    const check = assertTransitions({
      label: "continuous output",
      sample,
      steps: [
        {
          name: "hold",
          act: action,
          during: (_before, current) => current.matchingRatio === 1,
          sampleIntervalMs: 5,
          verify: (before, after) => before.matchingRatio === 1 && after.matchingRatio === 1,
        },
      ],
    });
    if (variant) await expect(check).rejects.toThrow("during hold");
    else await expect(check).resolves.toHaveLength(1);
    // Failed sampling returns early; wait for the caller-owned action's cleanup before reusing the page.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
});

it("rejects invalid or out-of-bounds regions instead of treating missing output as a pass", async () => {
  await subject("");
  for (const width of [0, -1, 500, 1.5]) {
    await expect(
      browser.page.evaluate(measureCanvasRegion, {
        selector: "#scene",
        x: 0,
        y: 0,
        width,
        height: 10,
        color: [0, 0, 0, 0],
      }),
    ).rejects.toThrow();
  }
});
