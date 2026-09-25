import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type BrowserJourney, runBrowserJourney } from "../../src/testing/browser-journey.js";
import { productJourneyGaps } from "../../src/workflow/evidence/product-journey.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-feedback-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function runFixture(name: string, repaired: boolean, actions: BrowserJourney["actions"]) {
  const html = await readFile(
    new URL(`../fixtures/product-quality/${name}.html`, import.meta.url),
    "utf8",
  );
  await writeFile(
    join(root, "index.html"),
    repaired ? html.replace("<body>", '<body class="repaired">') : html,
  );
  return runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      viewport: { width: 1280, height: 800 },
      actions,
    },
  });
}

it.each([false, true])(
  "natural unpressed travel exposes aim drift (repaired=%s)",
  async (repaired) => {
    const result = await runFixture("aim-travel", repaired, [
      { kind: "click", selector: "#range", position: { x: 0.2, y: 0.2 }, capture: false },
      { kind: "click", selector: "#launch", capture: false },
      { kind: "wait-for", selector: "#result", text: "Hit", timeoutMs: 100, capture: true },
    ]);
    expect(result.status).toBe(repaired ? "completed" : "timed-out");
    const observation = result.operations.find((operation) => operation.kind === "observe");
    expect(JSON.parse(observation?.measurement?.json ?? "null")).toMatchObject({
      matched: repaired,
      actual: { text: repaired ? "Hit" : "Miss" },
    });
    const travel = result.operations.filter((operation) =>
      operation.description.startsWith("Move pointer"),
    );
    expect(travel).toHaveLength(2);
    expect(JSON.parse(travel[1]?.measurement?.json ?? "null").path).toHaveLength(12);
    expect(result.captures).toHaveLength(2);
    expect(
      productJourneyGaps({
        subjectDigest: "a".repeat(64),
        images: result.captures,
        linkedEvidence: result.captures.map((capture) => capture.id),
        captureRuns: [
          { version: 2, provenance: "runner-executed", subjectDigest: "a".repeat(64), ...result },
        ],
      }),
    ).toHaveLength(repaired ? 0 : 1);
  },
);

it.each([false, true])(
  "observes disabled resource exhaustion without requiring reachability (repaired=%s)",
  async (repaired) => {
    const result = await runFixture("resource-exhaustion", repaired, [
      { kind: "click", selector: "#launch", capture: false },
      { kind: "click", selector: "#launch", capture: false },
      { kind: "wait-for", selector: "#launch", enabled: false, timeoutMs: 100, capture: false },
    ]);
    expect(result.status).toBe(repaired ? "completed" : "timed-out");
    const observations = result.operations.filter((operation) => operation.kind === "observe");
    expect(observations).toHaveLength(1);
    expect(JSON.parse(observations[0]?.measurement?.json ?? "null")).toMatchObject({
      matched: repaired,
      actual: { enabled: !repaired },
    });
  },
);

it("preserves initial composition, then explicitly scrolls to a working reset and observes absence", async () => {
  const result = await runFixture("resource-exhaustion", true, [
    { kind: "wait-for", selector: "#transient", visibility: "hidden", capture: false },
    { kind: "scroll", selector: "#reset", capture: true },
    { kind: "click", selector: "#reset", capture: false },
    { kind: "wait-for", selector: "#transient", visibility: "absent", capture: false },
    { kind: "wait-for", selector: "#status", text: "2 rounds", capture: false },
  ]);
  expect(result.status).toBe("completed");
  expect(result.captures).toHaveLength(3);
  const scroll = JSON.parse(
    result.operations.find((operation) => operation.kind === "scroll")?.measurement?.json ?? "null",
  );
  expect(scroll).toMatchObject({
    before: { y: 0, inViewport: false },
    after: { inViewport: true },
    matched: true,
  });
  expect(scroll.after.y).toBeGreaterThan(0);
});

it("does not silently scroll away a below-viewport control", async () => {
  const result = await runFixture("resource-exhaustion", true, [
    { kind: "click", selector: "#reset", capture: false },
  ]);
  expect(result).toMatchObject({
    status: "failed",
    failure: { kind: "behavior", message: expect.stringContaining("clipped") },
  });
  expect(result.operations.filter((operation) => operation.kind === "pointer")).toEqual([]);
});

it("rejects transformed coordinate claims instead of inventing a canvas mapping", async () => {
  await writeFile(
    join(root, "index.html"),
    '<button style="margin:100px;transform:rotate(20deg)">Rotate</button>',
  );
  const result = await runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      actions: [
        { kind: "click", selector: "button", position: { x: 0.2, y: 0.3 }, capture: false },
      ],
    },
  });
  expect(result).toMatchObject({
    status: "failed",
    failure: { message: expect.stringContaining("untransformed") },
  });
});

it.each(["covered-center", "clipped-edge"])(
  "uses an explicit visible canvas point while preserving selector-only checks (%s)",
  async (layout) => {
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><style>body{margin:0}canvas{position:absolute;left:80px;top:80px;width:${layout === "clipped-edge" ? 1600 : 400}px;height:240px;background:orange}#cover{position:absolute;left:260px;top:180px;width:40px;height:40px;background:black}</style><canvas id="range" onclick="document.querySelector('output').textContent='Landed'"></canvas>${layout === "covered-center" ? '<div id="cover"></div>' : ""}<output>Ready</output>`,
    );
    const url = pathToFileURL(join(root, "index.html")).href;
    const run = (position?: { x: number; y: number }) =>
      runBrowserJourney({
        projectRoot: root,
        directory: join(root, "captures"),
        subjectDigest: "a".repeat(64),
        journey: {
          url,
          actions: [
            { kind: "click", selector: "#range", position, capture: false },
            {
              kind: "wait-for",
              selector: "output",
              text: "Landed",
              timeoutMs: 100,
              capture: false,
            },
          ],
        },
      });
    expect((await run({ x: 0.2, y: 0.25 })).status).toBe("completed");
    expect((await run()).status).toBe("failed");
    const bad = await run({ x: layout === "covered-center" ? 0.5 : 0.9, y: 0.5 });
    expect(bad.status).toBe("failed");
    expect(bad.operations.filter((operation) => operation.kind === "pointer")).toEqual([]);
  },
);

it.each(["covered-center", "clipped-edge"])(
  "starts a drag at a visible origin without requiring the entire canvas (%s)",
  async (layout) => {
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><style>body{margin:0}#range{position:absolute;left:20px;top:20px;width:${layout === "clipped-edge" ? 1600 : 600}px;height:300px;background:lightblue}#cover{position:absolute;left:300px;top:150px;width:40px;height:40px;background:black}</style><div id="range" onmousedown="document.querySelector('output').textContent='Started'"></div>${layout === "covered-center" ? '<div id="cover"></div>' : ""}<output>Ready</output>`,
    );
    const result = await runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      journey: {
        url: pathToFileURL(join(root, "index.html")).href,
        actions: [
          {
            kind: "drag",
            selector: "#range",
            from: { x: 50, y: 50 },
            to: { x: 200, y: 100 },
            steps: 2,
            durationMs: 0,
            capture: false,
          },
          { kind: "wait-for", selector: "output", text: "Started", timeoutMs: 100, capture: false },
        ],
      },
    });
    expect(result.status).toBe("completed");
  },
);

it("retains the initial observation when a product freezes during real input", async () => {
  await writeFile(
    join(root, "index.html"),
    '<button id="freeze" onclick="while(true){}">Freeze</button>',
  );
  const result = await runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      actions: [{ kind: "click", selector: "#freeze", capture: false }],
    },
  });
  expect(result).toMatchObject({
    status: "timed-out",
    failure: { kind: "environment", actionIndex: 0 },
  });
  expect(result.captures).toHaveLength(1);
  expect(result.operations.some((operation) => operation.kind === "capture")).toBe(true);
  expect(
    productJourneyGaps({
      subjectDigest: "a".repeat(64),
      images: result.captures,
      linkedEvidence: result.captures.map((capture) => capture.id),
      captureRuns: [
        { version: 2, provenance: "runner-executed", subjectDigest: "a".repeat(64), ...result },
      ],
    }),
  ).toHaveLength(1);
});
