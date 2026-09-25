import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { browserJourneySchema, runBrowserJourney } from "../../src/testing/browser-journey.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-held-pointer-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it.each([
  { repaired: false, held: false, status: "completed" },
  { repaired: false, held: true, status: "timed-out" },
  { repaired: true, held: false, status: "completed" },
  { repaired: true, held: true, status: "completed" },
])(
  "observes real release behavior: repaired=$repaired held=$held",
  async ({ repaired, held, status }) => {
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><style>body{margin:0}button{width:100px;height:80px}</style>
<div id="panel"><button id="action">Upgrade</button></div><output id="result">0</output><script src="app.js"></script>`,
    );
    await writeFile(
      join(root, "app.js"),
      `let count=0;const panel=document.querySelector('#panel');
panel.addEventListener('click',e=>{if(e.isTrusted&&e.target.id==='action')document.querySelector('#result').textContent=String(++count)});
${repaired ? "" : "panel.addEventListener('pointerdown',()=>setTimeout(()=>panel.innerHTML='<button id=action>Upgrade</button>',35));"}`,
    );
    const journey = browserJourneySchema.parse({
      url: pathToFileURL(join(root, "index.html")).href,
      actions: [
        held
          ? {
              kind: "drag",
              selector: "#action",
              from: { x: 40, y: 40 },
              to: { x: 40, y: 40 },
              steps: 2,
              durationMs: 80,
            }
          : { kind: "click", selector: "#action" },
        { kind: "wait-for", selector: "#result", text: "1", timeoutMs: 300 },
      ],
    });
    const result = await runBrowserJourney({
      projectRoot: root,
      directory: join(root, "captures"),
      subjectDigest: "a".repeat(64),
      journey,
    });
    expect(result.status).toBe(status);
    if (status !== "completed") expect(result.failure?.kind).toBe("behavior");
    expect(result.operations.some((operation) => operation.kind === "pointer")).toBe(true);
  },
);
