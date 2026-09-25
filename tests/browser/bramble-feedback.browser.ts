import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { measureControl } from "../../src/testing/browser.js";
import { scrollToElement, waitForObservation } from "../../src/testing/browser-observations.js";
import { type BrowserSession, openBrowserSession } from "../../src/testing/browser-session.js";

const fixture = fileURLToPath(
  new URL("../fixtures/product-quality/bramble-brigade.html", import.meta.url),
);
const sourceHash = "8b06e6427c2a8f3234724c2c47c46923d58ae43d41d638b9f5bb0b8eb86b1e31";
const desktop = { width: 1280, height: 900 };
const signal = () => AbortSignal.timeout(10_000);

async function withFixture(
  viewport: { width: number; height: number },
  check: (session: BrowserSession) => Promise<void>,
) {
  expect(sha256(await readFile(fixture))).toBe(sourceHash);
  const directory = await mkdtemp(join(tmpdir(), "visp-bramble-feedback-"));
  const session = await openBrowserSession({
    subjectDigest: sourceHash,
    directory,
    fileRoot: dirname(fixture),
    viewport,
  });
  try {
    await session.navigate(pathToFileURL(fixture).href);
    await waitForObservation(
      session,
      { selector: "#game-status", text: "Ready to aim", timeoutMs: 1000 },
      signal(),
    );
    await check(session);
  } finally {
    await session.close();
    await rm(directory, { recursive: true, force: true });
    expect(sha256(await readFile(fixture))).toBe(sourceHash);
  }
}

function boardGeometry() {
  const rect = document.querySelector("#game-canvas")?.getBoundingClientRect();
  if (!rect) throw new Error("Missing game canvas");
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    viewport: { width: innerWidth, height: innerHeight },
    documentWidth: document.documentElement.scrollWidth,
  };
}

function boardPoint(rect: Awaited<ReturnType<typeof boardGeometry>>, x: number, y: number) {
  return { x: rect.x + (x * rect.width) / 1280, y: rect.y + (y * rect.height) / 720 };
}

/** Read only the ember-colored body pixels, with no access to closure-owned game state. */
function birdPixels() {
  const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
  const context = canvas?.getContext("2d");
  if (!canvas || !context) throw new Error("Missing rendered game canvas");
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0,
    xTotal = 0,
    yTotal = 0;
  for (
    let y = Math.ceil((200 * canvas.height) / 720);
    y < Math.floor((610 * canvas.height) / 720);
    y++
  )
    for (
      let x = Math.ceil((90 * canvas.width) / 1280);
      x < Math.floor((650 * canvas.width) / 1280);
      x++
    ) {
      const index = (y * canvas.width + x) * 4;
      if (
        Math.abs((data[index] ?? 0) - 242) > 3 ||
        Math.abs((data[index + 1] ?? 0) - 91) > 3 ||
        Math.abs((data[index + 2] ?? 0) - 77) > 3
      )
        continue;
      count++;
      xTotal += x;
      yTotal += y;
    }
  return {
    count,
    x: count ? ((xTotal / count) * 1280) / canvas.width : null,
    y: count ? ((yTotal / count) * 720) / canvas.height : null,
  };
}

async function movingBird(session: BrowserSession) {
  const deadline = Date.now() + 1500;
  let observed = await session.sample(birdPixels, undefined);
  while ((observed.x === null || observed.x < 255) && Date.now() < deadline) {
    await pause(16);
    observed = await session.sample(birdPixels, undefined);
  }
  expect(observed.count).toBeGreaterThan(20);
  expect(observed.x).toBeGreaterThan(250);
  return observed;
}

it("detects reversed vertical pull from native drag and early rendered flight", async () => {
  await withFixture(desktop, async (session) => {
    for (const [direction, pullY, expectedVertical] of [
      ["down", 580, "up"],
      ["up", 420, "down"],
    ] as const) {
      await session.navigate(pathToFileURL(fixture).href);
      const rect = await session.page.evaluate(boardGeometry, undefined);
      await session.capture();
      await session.drag({
        from: boardPoint(rect, 190, 500),
        to: boardPoint(rect, 100, pullY),
        input: "pointer",
        steps: 12,
        durationMs: 240,
      });
      const observed = await movingBird(session);
      const matched =
        observed.y !== null && (direction === "down" ? observed.y < 490 : observed.y > 510);
      session.record("observe", `Pull left and ${direction} launches opposite the vertical pull`, {
        expected: { verticalDirection: expectedVertical },
        actual: observed,
        matched,
      });
      expect(matched).toBe(false);
      expect(direction === "down" ? observed.y : 1000 - (observed.y ?? 1000)).toBeGreaterThan(515);
      await waitForObservation(
        session,
        { selector: "#bird-count", text: "03", timeoutMs: 300 },
        signal(),
      );
      await session.capture();
    }
    expect(
      session.operations.filter(
        (operation) =>
          operation.kind === "observe" && operation.measurement?.json.includes('"matched":false'),
      ),
    ).toHaveLength(2);
  });
}, 30_000);

it("detects Arrow then Space staying in aim while recording a concrete failed launch observation", async () => {
  await withFixture(desktop, async (session) => {
    await session.capture();
    await session.page.keyboard.press("ArrowLeft");
    await waitForObservation(
      session,
      { selector: "#game-status", text: "Aim set · press Space to launch", timeoutMs: 300 },
      signal(),
    );
    await session.page.keyboard.press("Space");
    await expect(
      waitForObservation(
        session,
        { selector: "#game-status", text: "Emberbird airborne", timeoutMs: 300 },
        signal(),
      ),
    ).rejects.toThrow("expected browser state");
    await waitForObservation(
      session,
      { selector: "#bird-count", text: "04", timeoutMs: 300 },
      signal(),
    );
    await session.capture();
    expect(session.operations.filter((operation) => operation.kind === "keyboard")).toHaveLength(2);
    const failed = session.operations.find(
      (operation) =>
        operation.kind === "observe" && operation.measurement?.json.includes('"matched":false'),
    );
    expect(JSON.parse(failed?.measurement?.json ?? "null")).toMatchObject({
      actual: { text: "Aim set · press Space to launch" },
      expected: { text: "Emberbird airborne" },
      matched: false,
    });
  });
}, 30_000);

it("observes intercepted restart centre and counterchecks the exposed edge with native clicks", async () => {
  await withFixture(desktop, async (session) => {
    await session.page.keyboard.press("ArrowLeft");
    const control = await session.page.evaluate(measureControl, "#restart-button");
    expect(control.reachable).toBe(false);
    expect(control.reasons.join()).toContain("covered");
    await session.page.mouse.click(control.x, control.y);
    await expect(
      waitForObservation(
        session,
        { selector: "#game-status", text: "Ready to aim", timeoutMs: 200 },
        signal(),
      ),
    ).rejects.toThrow("expected browser state");
    const edge = await session.page.evaluate(() => {
      const rect = document.querySelector("#restart-button")?.getBoundingClientRect();
      if (!rect) throw new Error("Missing restart control");
      return { x: rect.x + 12, y: rect.y + rect.height / 2 };
    }, undefined);
    await session.page.mouse.click(edge.x, edge.y);
    await waitForObservation(
      session,
      { selector: "#game-status", text: "Ready to aim", timeoutMs: 500 },
      signal(),
    );
    const observations = session.operations
      .filter((operation) => operation.kind === "observe")
      .map((operation) => JSON.parse(operation.measurement?.json ?? "null"));
    expect(observations.map((entry) => entry.matched)).toEqual([true, false, true]);
  });
}, 30_000);

it("retains clipped initial mobile layout and observes held touch aim separating from the bird", async () => {
  await withFixture({ width: 390, height: 844 }, async (session) => {
    const initial = await session.page.evaluate(boardGeometry, undefined);
    const visible = initial.y >= 0 && initial.y + initial.height <= initial.viewport.height;
    session.record("observe", "Initial mobile board fits the visible viewport", {
      expected: { fullyVisible: true },
      actual: initial,
      matched: visible,
    });
    expect(visible).toBe(false);
    await session.capture();
    await scrollToElement(
      session,
      { selector: "#game-canvas", block: "center", timeoutMs: 1000 },
      signal(),
    );
    const rect = await session.page.evaluate(boardGeometry, undefined);
    await session.drag(
      {
        from: boardPoint(rect, 190, 500),
        to: boardPoint(rect, 70, 374),
        input: "touch",
        steps: 12,
        durationMs: 300,
      },
      async () => {
        await pause(40);
        const observed = await session.page.evaluate(birdPixels, undefined);
        // dispatchDrag samples halfway through the held input, before releasing it.
        const expected = { x: 130, y: 437 };
        const distance = Math.hypot((observed.x ?? 0) - expected.x, (observed.y ?? 0) - expected.y);
        session.record("observe", "Held bird follows the dragged sling band", {
          expected,
          actual: observed,
          matched: observed.count > 5 && distance < 25,
        });
        expect(observed.count).toBeGreaterThan(5);
        expect(observed.x).toBeGreaterThan(170);
        expect(observed.y).toBeGreaterThan(475);
        expect(distance).toBeGreaterThan(50);
        await session.capture();
      },
    );
    await waitForObservation(
      session,
      { selector: "#bird-count", text: "03", timeoutMs: 500 },
      signal(),
    );
    expect(session.operations.filter((operation) => operation.kind === "touch")).toHaveLength(2);
    expect(
      session.operations.filter(
        (operation) =>
          operation.kind === "observe" && operation.measurement?.json.includes('"matched":false'),
      ),
    ).toHaveLength(2);
  });
}, 30_000);
