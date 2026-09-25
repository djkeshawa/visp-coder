import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { sha256 } from "../../src/core/hash.js";
import { browserInputIdentity } from "../../src/testing/browser-input-identity.js";
import { browserJourneySchema, runBrowserJourney } from "../../src/testing/browser-journey.js";
import { imageDimensions } from "../../src/workflow/evidence/observations/media.js";

// A chart editor, independent of the game evaluations. Its drawing must resize
// without discarding the user's selection. The broken variant draws only at load.
function chartFixture(responsive: boolean) {
  return `<!doctype html><meta name="viewport" content="width=device-width">
<style>html{overflow:hidden}body{margin:0}canvas{display:block;width:100%;aspect-ratio:2}
@media(max-width:600px){canvas{aspect-ratio:1}}</style>
<button id="select">Select point</button><output id="count">0</output>
<canvas id="chart"></canvas><script>
const chart=document.querySelector('#chart'), count=document.querySelector('#count');
document.querySelector('#select').onclick=()=>count.textContent=Number(count.textContent)+1;
function layout(){
  chart.width=chart.clientWidth;chart.height=chart.clientHeight;
  const ctx=chart.getContext('2d');ctx.fillStyle='#152736';ctx.fillRect(0,0,chart.width,chart.height);
  ctx.fillStyle='#54cbb4';ctx.beginPath();ctx.arc(chart.width/2,chart.height/2,80,0,Math.PI*2);ctx.fill();
}
layout();${responsive ? 'addEventListener("resize",layout);' : ""}
</script>`;
}

it.each([true, false])(
  "records an in-session layout transition without approving its quality (responsive=%s)",
  async (responsive) => {
    const root = await mkdtemp(join(tmpdir(), "visp-viewport-transition-"));
    try {
      const html = chartFixture(responsive);
      await writeFile(join(root, "index.html"), html);
      const resize = { kind: "resize", viewport: { width: 844, height: 390 }, capture: true };
      const journey = browserJourneySchema.parse({
        url: pathToFileURL(join(root, "index.html")).href,
        viewport: { width: 390, height: 844 },
        actions: [
          { kind: "click", selector: "#select" },
          resize,
          { kind: "click", selector: "#select" },
          { kind: "wait-for", selector: "#count", text: "2" },
        ],
      });
      const options = {
        journey,
        directory: join(root, "captures"),
        projectRoot: root,
        subjectDigest: sha256(html),
      };
      const recorded = await runBrowserJourney(options);
      // A successful viewport operation does not distinguish a distorted chart.
      expect(recorded.status).toBe("completed");
      expect(recorded.operations.filter((entry) => entry.kind === "navigate")).toHaveLength(1);
      expect(recorded.captures.map((capture) => capture.viewport)).toEqual([
        { width: 390, height: 844 },
        { width: 844, height: 390 },
        { width: 844, height: 390 },
      ]);
      for (const capture of recorded.captures) {
        expect(imageDimensions(await readFile(capture.path))).toMatchObject(capture.viewport);
      }
      const operation = recorded.operations.find((entry) =>
        entry.description.startsWith("Resize viewport"),
      );
      expect(JSON.parse(operation?.measurement?.json ?? "null")).toEqual({
        before: { width: 390, height: 844 },
        requested: { width: 844, height: 390 },
        observed: { width: 844, height: 390 },
      });
      expect(browserInputIdentity(journey.actions[1])).toBeUndefined();
      // This fixture's explicit drawing-size expectation catches the broken case.
      const checked = await runBrowserJourney({
        ...options,
        journey: browserJourneySchema.parse({
          ...journey,
          actions: [
            ...journey.actions,
            {
              kind: "wait-for",
              selector: "#chart",
              attribute: { name: "width", value: "844" },
              timeoutMs: 300,
            },
          ],
        }),
      });
      expect(checked.status).toBe(responsive ? "completed" : "timed-out");
      if (!responsive) expect(checked.failure).toMatchObject({ kind: "behavior", actionIndex: 4 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
