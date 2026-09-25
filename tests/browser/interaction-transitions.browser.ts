import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertTransitions } from "../../src/testing/transitions.js";
import { openChrome } from "./support/chrome.js";

let browser: Awaited<ReturnType<typeof openChrome>>;
let fixture: string;
beforeAll(async () => {
  browser = await openChrome();
  fixture = await readFile(
    new URL("../fixtures/product-quality/interaction.html", import.meta.url),
    "utf8",
  );
});
afterAll(async () => browser?.close());

async function sample() {
  return browser.page.evaluate(
    () => ({
      phase: document.querySelector("#phase")?.textContent,
      remaining: Number(document.querySelector("#remaining")?.textContent),
    }),
    undefined,
  );
}

it("detects a cancelled touch gesture consuming a resource", async () => {
  for (const repaired of [false, true]) {
    await browser.setContent(
      repaired ? fixture.replace("<body>", '<body class="repaired">') : fixture,
      390,
      844,
    );
    const check = assertTransitions({
      label: "touch cancellation",
      sample,
      steps: [
        {
          name: "cancel",
          act: async () => {
            await browser.send("Input.dispatchTouchEvent", {
              type: "touchStart",
              touchPoints: [{ x: 60, y: 60, id: 1 }],
            });
            await browser.send("Input.dispatchTouchEvent", {
              type: "touchMove",
              touchPoints: [{ x: 100, y: 100, id: 1 }],
            });
            await browser.send("Input.dispatchTouchEvent", {
              type: "touchCancel",
              touchPoints: [],
            });
          },
          verify: (before, after) =>
            after.phase === "ready" && before.remaining === after.remaining,
        },
      ],
    });
    if (repaired) await expect(check).resolves.toHaveLength(1);
    else await expect(check).rejects.toThrow("cancel");
  }
});

it("detects stale drag ownership after launching with the keyboard", async () => {
  for (const repaired of [false, true]) {
    await browser.setContent(
      repaired ? fixture.replace("<body>", '<body class="repaired">') : fixture,
      1280,
      800,
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 60,
      y: 60,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await browser.page.keyboard.press("Space");
    const check = assertTransitions({
      label: "mixed input",
      sample,
      steps: [
        {
          name: "release after keyboard launch",
          act: async () => {
            await browser.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 100,
              y: 100,
              buttons: 1,
            });
            await browser.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: 100,
              y: 100,
              button: "left",
              buttons: 0,
              clickCount: 1,
            });
          },
          verify: (before, after) =>
            before.phase === "running" &&
            after.phase === "running" &&
            before.remaining === after.remaining,
        },
      ],
    });
    if (repaired) await expect(check).resolves.toHaveLength(1);
    else await expect(check).rejects.toThrow("release after keyboard launch");
  }
});
