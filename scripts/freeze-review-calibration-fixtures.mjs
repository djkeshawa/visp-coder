// One-off, not run in CI: renders the frozen calibration scenarios from finished benchmark runs.
// Usage: node scripts/freeze-review-calibration-fixtures.mjs <runs-dir>   (needs `pnpm build` first)
// It copies the catapult preview regression source, and renders the slingshot-preview and catapult-finish
// images plus their recorded operations. Every game runs from a neutral temporary directory so the
// recorded operations never name the run, the arm or the variant.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openBrowserSession } from "../dist/testing.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/review-calibration");
const runs = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!runs) throw new Error("Supply the benchmark runs directory as the first argument.");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Chosen by looking at the rendered held and released frames (see the README in the fixture directory).
const SOURCES = {
  "catapult-preview": "cat-cat-vcat-1",
  "slingshot-preview": { defective: "i1-game-vnt1-1", control: "gv-game-v-1" },
  "catapult-finish": { defective: "cat-cat-vcat-1", control: "cat-cat-bmad-1" },
};

async function copyProject(run, directory) {
  const project = join(runs, run, "project");
  const files = {};
  for (const file of (await readdir(project)).filter((name) => /\.(html|js|css)$/.test(name))) {
    files[file] = await readFile(join(project, file));
    await writeFile(join(directory, file), files[file]);
  }
  return files;
}

async function render(scenario, variant, run, script) {
  const directory = await mkdtemp(join(tmpdir(), "visp-freeze-"));
  const target = join(fixtures, scenario);
  await mkdir(target, { recursive: true });
  try {
    const files = await copyProject(run, directory);
    const inputs = Object.entries(files).map(([file, bytes]) => ({ file, sha256: hash(bytes) }));
    const session = await openBrowserSession({ directory: join(directory, "captures"), fileRoot: directory,
      subjectDigest: hash(JSON.stringify(inputs)), viewport: { width: 1280, height: 800 } });
    try {
      await session.navigate(pathToFileURL(join(directory, "index.html")).href);
      let frame = 0;
      const capture = async (state) => {
        const image = await session.capture();
        await writeFile(join(target, `${variant}-${++frame}-${state}.png`), await readFile(image.path));
      };
      await script(session, capture);
      await writeFile(join(target, `${variant}-execution.json`), `${JSON.stringify({ inputs, operations: session.operations, provenance: "runner-observed" }, null, 2)}\n`);
    } finally { await session.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Pull the resting bird back and to the lower left, hold at full pull, release, then capture two frames of flight.
async function slingshotPull(session, capture) {
  const { box, bird } = await session.page.evaluate(() => {
    const rect = document.querySelector("#game").getBoundingClientRect();
    return { box: { left: rect.left, top: rect.top, scale: rect.width / 960 }, bird: gameTest.snapshot().bird };
  }, undefined);
  const world = (x, y) => ({ x: Math.round(box.left + x * box.scale), y: Math.round(box.top + y * box.scale) });
  const from = world(bird.x, bird.y), to = world(bird.x - 72, bird.y + 32);
  await capture("initial");
  await session.drag({ from, to, input: "pointer", steps: 8, durationMs: 240 }, async () => {
    await session.page.mouse.move(to.x, to.y);
    await sleep(120);
    await capture("held");
  });
  const releasedAt = Date.now();
  for (const delay of [150, 350]) {
    await sleep(Math.max(0, releasedAt + delay - Date.now()));
    await capture(`released-${delay}ms`);
  }
}

async function levelFrames(session, capture) {
  for (const level of [1, 3]) {
    await session.page.evaluate((next) => { gameTest.pause(); gameTest.restart(next); gameTest.step(500); return next; }, level);
    await sleep(300);
    await capture(`level-${level}`);
  }
}

// catapult-preview: freeze the defective source; the control is patched in review-calibration-fixtures.mjs.
const previewDirectory = join(root, "tests/fixtures/product-quality/catapult-preview-regression");
await mkdir(previewDirectory, { recursive: true });
const previewFiles = {};
for (const file of ["index.html", "game.js", "styles.css"]) {
  const bytes = await readFile(join(runs, SOURCES["catapult-preview"], "project", file));
  await writeFile(join(previewDirectory, file), bytes);
  previewFiles[file] = hash(bytes);
}
await writeFile(join(previewDirectory, "provenance.json"), `${JSON.stringify({
  source: "Siege catapult benchmark run, VISP arm, 2026-09-29",
  files: previewFiles,
  scope: "Product source only; no conversation, credentials, or VISP history copied",
}, null, 2)}\n`);

for (const variant of ["defective", "control"]) {
  await render("slingshot-preview", variant, SOURCES["slingshot-preview"][variant], slingshotPull);
  await render("catapult-finish", variant, SOURCES["catapult-finish"][variant], levelFrames);
}
console.log("Frozen calibration fixtures written under " + fixtures);
