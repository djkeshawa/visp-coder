import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";
import { pngPixel } from "./support/png-pixel.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-local-drag-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const html = `<!doctype html><style>#pad {width:300px;height:200px;background:orange;touch-action:none} body{margin:0}</style><div id="pad">Ready</div><script src="app.js"></script>`;
const script = `const pad=document.querySelector('#pad');let down=false;pad.addEventListener('pointerdown',e=>{if(e.isTrusted){down=true;pad.setPointerCapture(e.pointerId);pad.textContent='Dragging';pad.style.background='lightblue'}});pad.addEventListener('pointermove',e=>{if(down&&e.isTrusted)pad.dataset.x=String(e.clientX)});pad.addEventListener('pointerup',e=>{if(down&&e.isTrusted){down=false;pad.textContent='Released';pad.style.background='limegreen';pad.dataset.input=e.pointerType}});`;
it.each(["pointer", "touch"] as const)(
  "captures real %s drag before, during and after release from confined files",
  async (input) => {
    await writeFile(join(root, "index.html"), html);
    await writeFile(join(root, "app.js"), script);
    const result = await runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      journey: {
        url: pathToFileURL(join(root, "index.html")).href,
        actions: [
          {
            kind: "drag",
            selector: "#pad",
            from: { x: 50, y: 50 },
            to: { x: 250, y: 50 },
            input,
            steps: 4,
            durationMs: 100,
            captureDuring: true,
            capture: true,
          },
          {
            kind: "wait-for",
            selector: "#pad",
            text: "Released",
            attribute: { name: "data-input", value: input === "pointer" ? "mouse" : "touch" },
            timeoutMs: 500,
            capture: false,
          },
        ],
      },
    });
    expect(result.captures).toHaveLength(4);
    expect(new Set(result.captures.slice(0, 3).map((entry) => entry.sha256)).size).toBe(3);
    expect(result.captures[1]?.steps.some((step) => step.startsWith("Begin"))).toBe(true);
    expect(result.captures[1]?.steps.some((step) => step.startsWith("Finish"))).toBe(false);
    expect(result.operations.filter((entry) => entry.kind === input)).toHaveLength(
      input === "pointer" ? 3 : 2,
    );
    expect(
      result.operations.some((entry) => entry.measurement?.json.includes('"text":"Released"')),
    ).toBe(true);
  },
);
it.each(["image", "iframe", "script"])(
  "rejects an outside-project %s request without publishing a journey",
  async (kind) => {
    const outside = await mkdtemp(join(tmpdir(), "visp-outside-"));
    try {
      await writeFile(join(outside, "private.txt"), "private bytes");
      const url = pathToFileURL(join(outside, "private.txt")).href;
      await writeFile(
        join(root, "index.html"),
        `<html><${kind === "image" ? "img" : kind} src="${url}"></${kind}></html>`,
      );
      await expect(
        runBrowserJourney({
          projectRoot: root,
          directory: join(root, "captures"),
          subjectDigest: "a".repeat(64),
          journey: { url: pathToFileURL(join(root, "index.html")).href, actions: [] },
        }),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  },
);
it("rejects symlinked resources and project-blocked subresources", async () => {
  await writeFile(join(root, "private.js"), "document.body.textContent='should not execute'");
  await symlink(join(root, "private.js"), join(root, "app.js"));
  await writeFile(join(root, "index.html"), html);
  const options = {
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: { url: pathToFileURL(join(root, "index.html")).href, actions: [] },
  };
  await expect(runBrowserJourney(options)).rejects.toThrow();
  await rm(join(root, "app.js"));
  await writeFile(join(root, "app.js"), script);
  await expect(runBrowserJourney({ ...options, blockedPaths: ["app.js"] })).rejects.toThrow(
    /allowed project content/,
  );
});
it("does not accept an incorrect intermediate transition because the control exists", async () => {
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "app.js"), script);
  const result = await runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      actions: [
        { kind: "wait-for", selector: "#pad", text: "Released", timeoutMs: 100, capture: false },
      ],
    },
  });
  expect(result).toMatchObject({
    status: "timed-out",
    failure: { kind: "behavior", message: expect.stringContaining("expected browser state") },
  });
});

it.each(["popup", "worker"])(
  "reports unsupported local-file %s targets without a passing capture",
  async (kind) => {
    await writeFile(
      join(root, "index.html"),
      `<html><button onclick="${kind === "popup" ? "window.open('about:blank')" : "new Worker(window.URL.createObjectURL(new Blob(['postMessage(1)'],{type:'text/javascript'})))"}">Open</button></html>`,
    );
    await expect(
      runBrowserJourney({
        projectRoot: root,
        directory: join(root, "captures"),
        subjectDigest: "a".repeat(64),
        journey: {
          url: pathToFileURL(join(root, "index.html")).href,
          actions: [{ kind: "click", selector: "button", capture: true }],
        },
      }),
    ).rejects.toThrow(/extra browsing targets|security policy/);
  },
);

// A fit-to-window canvas: 800x600 in its own coordinates, scaled by its ancestor to the viewport.
const scaledHtml = `<!doctype html><style>body{margin:0}#stage{transform-origin:0 0;width:800px;height:600px}#pad{display:block;width:800px;height:600px;background:orange;touch-action:none}</style><div id="stage"><canvas id="pad" width="800" height="600"></canvas></div><output id="report">Ready</output><script src="scaled.js"></script>`;
const scaledScript = (property: "transform" | "scale") =>
  `const stage=document.querySelector('#stage'),pad=document.querySelector('#pad'),out=document.querySelector('#report');const k=Math.min(innerWidth/800,innerHeight/600,0.8);${property === "transform" ? "stage.style.transform='scale('+k+')'" : "stage.style.scale=String(k)"};let start,last;const local=e=>[Math.round(e.offsetX),Math.round(e.offsetY)];pad.addEventListener('pointerdown',e=>{if(!e.isTrusted)return;pad.setPointerCapture(e.pointerId);start=last=local(e)});pad.addEventListener('pointermove',e=>{if(start&&e.isTrusted)last=local(e)});pad.addEventListener('pointerup',e=>{if(!start||!e.isTrusted)return;out.textContent='Released';out.dataset.start=start.join(',');out.dataset.delta=[last[0]-start[0],last[1]-start[1]].join(',');start=undefined});`;
const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;
const directions = [
  ["right", { x: 0.25, y: 0 }, "200,0"],
  ["left and down", { x: -0.25, y: 0.125 }, "-200,75"],
  ["straight up", { x: 0, y: -0.25 }, "0,-150"],
  ["up and right", { x: 0.125, y: -0.25 }, "100,-150"],
] as const;
async function dragScaled(
  property: "transform" | "scale",
  viewport: (typeof viewports)[number],
  by: { x: number; y: number },
  delta: string,
  input: "pointer" | "touch" = "pointer",
) {
  await writeFile(join(root, "index.html"), scaledHtml);
  await writeFile(join(root, "scaled.js"), scaledScript(property));
  // Local canvas coordinates: the press lands at 0.5 and 0.75 of 800x600 and the travel is by * (800, 600).
  const observe = (name: string, value: string) => ({
    kind: "wait-for" as const,
    selector: "#report",
    text: "Released",
    attribute: { name, value },
    timeoutMs: 1000,
    capture: false,
  });
  return await runBrowserJourney({
    projectRoot: root,
    directory: join(root, "captures"),
    subjectDigest: "a".repeat(64),
    journey: {
      url: pathToFileURL(join(root, "index.html")).href,
      viewport,
      actions: [
        {
          kind: "drag",
          selector: "#pad",
          position: { x: 0.5, y: 0.75 },
          by,
          input,
          steps: 6,
          durationMs: 60,
          capture: false,
        },
        observe("data-start", "400,450"),
        observe("data-delta", delta),
      ],
    },
  });
}
describe("drag position and by on a scaled canvas", () => {
  it.each(
    viewports.flatMap((viewport) =>
      directions.map(([name, by, delta]) => [viewport.width, name, viewport, by, delta] as const),
    ),
  )(
    "moves by fractions of the visible box at %i px wide: %s",
    async (_width, _name, viewport, by, delta) => {
      const result = await dragScaled("transform", viewport, by, delta);
      expect(result).toMatchObject({ status: "completed" });
    },
  );
  it("also follows a CSS scale property and a touch finger", async () => {
    for (const [property, input] of [
      ["scale", "pointer"],
      ["transform", "touch"],
    ] as const) {
      const result = await dragScaled(
        property,
        viewports[1],
        { x: -0.25, y: -0.25 },
        "-200,-150",
        input,
      );
      expect(result).toMatchObject({ status: "completed" });
    }
  });
  // [name, css, a start point inside the transformed box (stage margin 200px, origin at its corner)]
  it.each([
    ["rotated", "#stage{transform:rotate(15deg)}", { x: 508, y: 593 }],
    ["skewed", "#stage{transform:skewX(20deg)}", { x: 709, y: 500 }],
    ["flipped", "#stage{transform:translateX(800px) scaleX(-1)}", { x: 600, y: 500 }],
    [
      "rotated by offset-path",
      '#pad{offset-path:path("M 400 300 L 500 300");offset-anchor:50% 50%;offset-rotate:30deg}',
      { x: 600, y: 500 },
    ],
  ] as const)(
    "still refuses %s geometry for by alone, from and by, and position and by",
    async (_name, css, inside) => {
      await writeFile(
        join(root, "index.html"),
        scaledHtml.replace("<script", `<style>#stage{margin:200px}${css}</style><script`),
      );
      await writeFile(join(root, "scaled.js"), "");
      for (const action of [
        { by: { x: 0.1, y: 0.1 } },
        ...(inside ? [{ from: inside, by: { x: 0.1, y: 0.1 } }] : []),
        { position: { x: 0.5, y: 0.5 }, by: { x: 0.1, y: 0.1 } },
      ]) {
        const result = await runBrowserJourney({
          projectRoot: root,
          directory: join(root, "captures"),
          subjectDigest: "a".repeat(64),
          journey: {
            url: pathToFileURL(join(root, "index.html")).href,
            // Room for the transformed box, so only the geometry guard can refuse.
            viewport: { width: 1800, height: 1400 },
            actions: [{ kind: "drag", selector: "#pad", capture: false, ...action }],
          },
        });
        expect(result).toMatchObject({
          status: "failed",
          failure: { message: expect.stringContaining("rotated, skewed or perspective") },
        });
        expect(result.operations.filter((entry) => entry.kind === "pointer")).toEqual([]);
      }
    },
  );
});

// A frame-driven pull indicator: the swatch is red only once the pointer has travelled the full
// 200 px, blue after release, and green 700 ms after release.
const pullHtml = `<!doctype html><style>body{margin:0;background:#fff}#pad{width:300px;height:200px;background:#ddd;touch-action:none}#swatch{position:absolute;left:330px;top:230px;width:40px;height:40px}</style><div id="pad"></div><div id="swatch"></div><script src="pull.js"></script>`;
const pullScript = `const pad=document.querySelector('#pad'),swatch=document.querySelector('#swatch');let state='idle',startX=0,pull=0;const paint=()=>{swatch.style.background=state==='idle'?'rgb(128,128,128)':state==='pulling'?(pull>=0.99?'rgb(255,0,0)':'rgb(255,165,0)'):state==='released'?'rgb(0,0,255)':'rgb(0,200,0)';requestAnimationFrame(paint)};paint();pad.addEventListener('pointerdown',e=>{if(!e.isTrusted)return;pad.setPointerCapture(e.pointerId);startX=e.clientX;pull=0;state='pulling'});pad.addEventListener('pointermove',e=>{if(state==='pulling'&&e.isTrusted)pull=Math.min(1,(e.clientX-startX)/200)});pad.addEventListener('pointerup',e=>{if(state!=='pulling'||!e.isTrusted)return;state='released';setTimeout(()=>{state='settled'},700)});`;
const near = (actual: readonly number[], expected: readonly number[]) =>
  actual.every((channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= 12);
it.each(["pointer", "touch"] as const)(
  "captures the fully pulled state, then two frames after %s release",
  async (input) => {
    await writeFile(join(root, "index.html"), pullHtml);
    await writeFile(join(root, "pull.js"), pullScript);
    const result = await runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      journey: {
        url: pathToFileURL(join(root, "index.html")).href,
        viewport: { width: 400, height: 300 },
        actions: [
          {
            kind: "drag",
            selector: "#pad",
            from: { x: 50, y: 50 },
            to: { x: 250, y: 50 },
            input,
            steps: 5,
            durationMs: 100,
            captureDuring: true,
            captureAfterMs: [100, 1200],
            capture: false,
          },
        ],
      },
    });
    expect(result.status).toBe("completed");
    // initial, held, +100 ms, +1200 ms, final
    expect(result.captures).toHaveLength(5);
    expect(new Set(result.captures.map((entry) => entry.sha256)).size).toBeGreaterThanOrEqual(4);
    const swatches = await Promise.all(
      result.captures.map((entry) => pngPixel(entry.path, 350, 250)),
    );
    expect(swatches.map((pixel, index) => [index, near(pixel, [128, 128, 128])])[0]).toEqual([
      0,
      true,
    ]);
    expect(near(swatches[1] ?? [], [255, 0, 0])).toBe(true);
    expect(near(swatches[2] ?? [], [0, 0, 255])).toBe(true);
    expect(near(swatches[3] ?? [], [0, 200, 0])).toBe(true);
    expect(result.captures[1]?.steps.some((step) => step.startsWith("Finish"))).toBe(false);
  },
);
