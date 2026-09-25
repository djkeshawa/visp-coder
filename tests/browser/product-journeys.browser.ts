import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateControl, assertControlReachable } from "../../src/testing/browser.js";
import { openChrome } from "./support/chrome.js";

let browser: Awaited<ReturnType<typeof openChrome>>;
let fixture: string;
beforeAll(async () => {
  fixture = await readFile(
    new URL("../fixtures/product-quality/recovery.html", import.meta.url),
    "utf8",
  );
  browser = await openChrome();
});
afterAll(async () => {
  await browser?.close();
});

describe("rendered product acceptance", () => {
  it("exercises native Space separately from Enter on a focused reset control", async () => {
    const markup = `<button id="reset">Reset</button><output id="phase">ready</output>
      <script>reset.onclick = () => phase.textContent = 'reset';
      window.onkeydown = event => { if(event.key === ' ') {event.preventDefault();phase.textContent = 'launched';} };</script>`;
    await browser.setContent(markup, 390, 844);
    await activateControl(browser.page, "#reset", "keyboard", 5, "Space");
    expect(
      await browser.page.evaluate(() => document.querySelector("#phase")?.textContent, undefined),
    ).toBe("launched");
    await browser.setContent(
      markup.replace(
        "if(event.key === ' ')",
        "if(event.key === ' ' && event.target === document.body)",
      ),
      390,
      844,
    );
    await activateControl(browser.page, "#reset", "keyboard", 5, "Space");
    expect(
      await browser.page.evaluate(() => document.querySelector("#phase")?.textContent, undefined),
    ).toBe("reset");
  });

  it("detects the clipped mobile retry that a DOM click would hide", async () => {
    await browser.setContent(fixture, 390, 844);
    await activateControl(browser.page, "#launch", "touch");
    await expect(assertControlReachable(browser.page, "#retry")).rejects.toThrow("clipped");
    // Demonstrate the false positive, not a permitted acceptance interaction.
    await browser.page.evaluate(
      () => document.querySelector<HTMLButtonElement>("#retry")?.click(),
      undefined,
    );
    expect(
      await browser.page.evaluate(() => document.querySelector("#phase")?.textContent, undefined),
    ).toBe("ready");
  });

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    for (const input of ["pointer", "touch", "keyboard"] as const) {
      it(`completes launch → failure → retry at ${width}×${height} using ${input}`, async () => {
        await browser.setContent(
          fixture.replace("<body>", '<body class="repaired">'),
          width,
          height,
        );
        await activateControl(browser.page, "#launch", input);
        expect(
          await browser.page.evaluate(
            () => document.querySelector("#phase")?.textContent,
            undefined,
          ),
        ).toBe("failed");
        await activateControl(browser.page, "#retry", input);
        expect(
          await browser.page.evaluate(
            () => document.querySelector("#phase")?.textContent,
            undefined,
          ),
        ).toBe("ready");
      });
    }
  }

  it("rejects covered, hidden, disabled, ambiguous and keyboard-inaccessible controls", async () => {
    for (const markup of [
      '<button id="control" disabled>Go</button>',
      '<button id="control" style="opacity:0">Go</button>',
      '<button id="control">Go</button><div style="position:fixed;inset:0;background:white"></div>',
      '<button id="control">One</button><button id="control">Two</button>',
    ]) {
      await browser.setContent(markup, 390, 844);
      await expect(assertControlReachable(browser.page, "#control")).rejects.toThrow();
    }
    await browser.setContent('<div id="control">Clickable only with a pointer</div>', 390, 844);
    await expect(activateControl(browser.page, "#control", "keyboard", 3)).rejects.toThrow(
      "not reachable by keyboard",
    );
    await expect(assertControlReachable(browser.page, "#missing")).rejects.toThrow("found 0");
  });
});
