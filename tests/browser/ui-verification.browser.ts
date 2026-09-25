import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertUiState } from "../../src/testing/ui.js";
import { openChrome } from "./support/chrome.js";

let browser: Awaited<ReturnType<typeof openChrome>>;
beforeAll(async () => {
  browser = await openChrome();
});
afterAll(async () => {
  await browser?.close();
});

const layout = `<style>body{margin:0}button{min-width:100px;min-height:44px}#board{width:350px;aspect-ratio:16/9;background:teal}</style>
  <main id="content"><div id="board"></div><button id="retry">Retry</button></main>`;
const contract = {
  name: "failure",
  viewport: { width: 390, height: 844 },
  controls: [{ selector: "#retry", minWidth: 44, minHeight: 44 }],
  regions: [{ selector: "#board", aspectRatio: 16 / 9, tolerance: 0.01 }],
};

describe("objective UI refinement", () => {
  it("rejects a distorted playfield and accepts the proportionally sized version", async () => {
    await browser.setContent(`${layout}<style>#board{min-height:240px}</style>`, 390, 844);
    await expect(assertUiState(browser.page, contract)).rejects.toThrow("aspect ratio");
    await browser.setContent(layout, 390, 844);
    await expect(assertUiState(browser.page, contract)).resolves.toMatchObject({
      name: "failure",
      viewport: { width: 390, height: 844 },
    });
  });

  it.each([
    ["overflow", "body{width:405px}"],
    ["minimum", "button{min-width:0;min-height:0;width:30px;height:20px}"],
    ["clipped", "#content{height:10px;overflow:hidden}"],
    [
      "covered",
      "#retry:after{content:'';position:fixed;inset:0;background:white;pointer-events:auto}#board{position:fixed;inset:0;z-index:10;width:100vw;height:100vh}",
    ],
  ])("detects %s in the current rendered state", async (_name, css) => {
    await browser.setContent(`${layout}<style>${css}</style>`, 390, 844);
    await expect(assertUiState(browser.page, contract)).rejects.toThrow();
  });

  it("checks text clipping only when the contract promises full text", async () => {
    await browser.setContent(
      `${layout}<p id="label" style="width:40px;white-space:nowrap;overflow:hidden">A long required message</p>`,
      390,
      844,
    );
    await expect(
      assertUiState(browser.page, {
        ...contract,
        regions: [{ selector: "#label", fullText: true }],
      }),
    ).rejects.toThrow("text");
    await expect(
      assertUiState(browser.page, { ...contract, regions: [{ selector: "#label" }] }),
    ).resolves.toBeDefined();
  });

  it("refuses wrong viewports, empty contracts, invalid tolerances, and missing regions", async () => {
    await browser.setContent(layout, 390, 844);
    await expect(
      assertUiState(browser.page, { ...contract, viewport: { width: 1280, height: 800 } }),
    ).rejects.toThrow("viewport");
    await expect(
      assertUiState(browser.page, { name: "empty", viewport: contract.viewport }),
    ).rejects.toThrow("control or region");
    await expect(
      assertUiState(browser.page, {
        ...contract,
        regions: [{ selector: "#board", aspectRatio: 16 / 9, tolerance: NaN }],
      }),
    ).rejects.toThrow("tolerance");
    await expect(
      assertUiState(browser.page, { ...contract, regions: [{ selector: "#missing" }] }),
    ).rejects.toThrow("found 0");
  });
});
