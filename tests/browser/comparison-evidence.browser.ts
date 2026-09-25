import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { browserJourneySchema, runBrowserJourney } from "../../src/testing/browser-journey.js";
import { summarizeObservation } from "../../src/workflow/product/observation-summary.js";

it("fails a real inconsistent result despite a passing ready flag, and exercises native cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "visp-compare-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><span id="hud">1043</span><span id="result">1014</span>
      <div id="target" data-state="ready" style="width:200px;height:180px;background:teal;touch-action:none"></div>
      <button id="fix" onclick="document.querySelector('#result').textContent='1043'">Correct result</button>
      <script>const target=document.querySelector('#target'); target.addEventListener('pointerdown', e=>target.setPointerCapture(e.pointerId)); target.addEventListener('pointercancel', ()=>target.dataset.state='cancelled'); target.addEventListener('pointerup', ()=>target.dataset.state='launched');</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server port");
    const run = (actions: unknown[]) =>
      runBrowserJourney({
        directory,
        subjectDigest: "a".repeat(64),
        journey: browserJourneySchema.parse({ url: `http://127.0.0.1:${address.port}/`, actions }),
      });
    const compare = {
      kind: "compare",
      left: { selector: "#hud" },
      right: { selector: "#result" },
      relation: "equal",
      mode: "number",
    };
    const failed = await run([
      { kind: "wait-for", selector: "#target", attribute: { name: "data-state", value: "ready" } },
      compare,
    ]);
    expect(failed.status).toBe("failed");
    const observations = failed.operations
      .filter((entry) => entry.kind === "observe")
      .map(summarizeObservation);
    expect(observations.map((entry) => entry.status)).toEqual(["matched", "not-matched"]);
    expect(observations[1]?.actual).toMatchObject({
      left: { value: "1043" },
      right: { value: "1014" },
    });
    const corrected = await run([
      { kind: "click", selector: "#fix" },
      compare,
      { kind: "drag", selector: "#target", to: { x: 120, y: 90 }, input: "touch", cancel: true },
      {
        kind: "wait-for",
        selector: "#target",
        attribute: { name: "data-state", value: "cancelled" },
        timeoutMs: 1000,
      },
    ]);
    expect(corrected.status).toBe("completed");
    expect(
      corrected.operations.some(
        (entry) => entry.kind === "touch" && entry.description.startsWith("Cancel touch"),
      ),
    ).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
