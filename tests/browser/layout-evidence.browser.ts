import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runBrowserJourney } from "../../src/testing/browser-journey.js";
import { summarizeLayout } from "../../src/workflow/product/observation-summary.js";

it("automatically measures distorted canvas and clipped instructions, then records corrected layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-layout-"));
  // Independent minimal page, not a copy or alternative surface for the audited game.
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><style>
      canvas { width:350px; height:auto; min-height:300px; padding:0 }
      #overlay { overflow:hidden; width:300px; height:30px }
      p { margin:0; height:60px }
      .fixed canvas { min-height:0 }
      .fixed #overlay { height:60px }
    </style><canvas id="game" width="960" height="540"></canvas>
    <div id="overlay"><p id="instructions">Controls and instructions</p></div>
    <button id="fix" onclick="document.body.classList.add('fixed')">Apply layout correction</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    const result = await runBrowserJourney({
      directory,
      subjectDigest: "a".repeat(64),
      journey: {
        url: `http://127.0.0.1:${address.port}/`,
        viewport: { width: 390, height: 844 },
        actions: [{ kind: "click", selector: "#fix", capture: true }],
      },
    });
    const summaries = result.operations.flatMap((entry) =>
      summarizeLayout(entry, new Set(result.captures.map((capture) => capture.id))),
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.canvases[0]?.scaleRatio).toBeCloseTo(1.5238, 3);
    expect(summaries[0]?.clipped).toContainEqual({
      element: "p#instructions",
      visibleFraction: 0.5,
    });
    expect(summaries[1]?.canvases[0]?.scaleRatio).toBeCloseTo(1, 2);
    expect(summaries[1]?.clipped).toEqual([]);
    expect(summaries[1]?.concerns).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports a small proportional activity and controls below the viewport without declaring a quality pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-layout-usability-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><canvas id="activity" width="1280" height="720" style="width:308px;height:173px"></canvas><div style="height:900px">Supporting content</div><button id="retry">Try again</button>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const result = await runBrowserJourney({
      directory,
      subjectDigest: "b".repeat(64),
      journey: {
        url: `http://127.0.0.1:${address.port}/`,
        viewport: { width: 390, height: 844 },
        actions: [],
      },
    });
    const layouts = result.operations.flatMap((entry) =>
      summarizeLayout(entry, new Set(result.captures.map((c) => c.id))),
    );
    expect(layouts[0]?.canvases[0]?.viewportAreaFraction).toBeCloseTo(0.162, 2);
    expect(layouts[0]?.usability.offscreenControls).toContain("button#retry");
    expect(layouts[0]?.concerns).toEqual([]);
    expect(layouts[0]?.usability.guidance).toContain("too small");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
