import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { assertControlReachable } from "../../src/testing/browser.js";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";
import { actAtPoint } from "../../src/testing/browser-points.js";
import type { BrowserSession } from "../../src/testing/browser-session.js";
import { openChrome } from "./support/chrome.js";

it("hovers a partially clipped surface while preserving whole-control and actual-point checks", async () => {
  const browser = await openChrome();
  try {
    const markup = `<style>body{margin:0} #surface{position:absolute;top:200px;width:600px;height:700px;background:skyblue}</style>
      <div id="surface" onpointermove="this.dataset.hovered='yes'"></div>`;
    await browser.setContent(markup, 1280, 720);
    const session = { page: browser.page } as unknown as BrowserSession;
    await expect(assertControlReachable(browser.page, "#surface")).rejects.toThrow("clipped");
    await actAtPoint(session, { kind: "move", selector: "#surface" });
    expect(
      await browser.page.evaluate(
        () => document.querySelector<HTMLElement>("#surface")?.dataset.hovered,
        undefined,
      ),
    ).toBe("yes");
    for (const extra of [
      "<style>#surface{top:500px}</style>",
      "<div style='position:fixed;inset:0;background:white'></div>",
      "<script>surface.onpointerenter=()=>surface.style.transform='translateX(700px)'</script>",
    ]) {
      await browser.page.mouse.move?.(0, 0);
      await browser.setContent(markup + extra, 1280, 720);
      await expect(
        actAtPoint(session, { kind: "move", selector: "#surface" }),
        extra,
      ).rejects.toThrow(/clipped|covered|reachable/);
    }
  } finally {
    await browser.close();
  }
});

async function observe(html: string) {
  const root = await mkdtemp(join(tmpdir(), "visp-observe-"));
  try {
    await writeFile(join(root, "index.html"), html);
    return await runBrowserJourney({
      subjectDigest: "0".repeat(64),
      projectRoot: root,
      directory: join(root, "captures"),
      journey: {
        url: pathToFileURL(join(root, "index.html")).href,
        actions: [
          { kind: "click", selector: "button", capture: false },
          { kind: "wait-for", selector: "button", text: "hit", timeoutMs: 500, capture: false },
        ],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it("permits harmless hover movement but rejects a target that escapes the click point", async () => {
  const page = (distance: number) =>
    `<style>button {width:180px;height:90px} button:hover{transform:translateX(${distance}px)}</style><button onclick="this.textContent='hit'">ready</button>`;
  expect((await observe(page(2))).status).toBe("completed");
  const escaped = await observe(page(200));
  expect(escaped.status).toBe("failed");
  expect(escaped.failure?.message).toMatch(/reachable|covered/);
});
it("reports the responsible application exception instead of only an observation timeout", async () => {
  const broken = await observe(
    `<button onclick="document.querySelector('#target-count').textContent='1'">ready</button>`,
  );
  expect(broken.status).toBe("failed");
  expect(broken.failure?.kind).toBe("behavior");
  expect(broken.failure?.message).toContain("Application JavaScript error");
  expect(broken.failure?.message).toContain("textContent");
  expect(broken.operations.some((op) => op.description === "Uncaught application exception")).toBe(
    true,
  );
  expect(
    (
      await observe(
        `<span id="target-count"></span><button onclick="document.querySelector('#target-count').textContent='1';this.textContent='hit'">ready</button>`,
      )
    ).status,
  ).toBe("completed");
});
