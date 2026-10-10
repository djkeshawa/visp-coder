// Offline capture preparation. Uses the installed browser in an isolated, sandboxed profile.
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { activateControl, openBrowserSession } from "../dist/testing.js";
import { CALIBRATION_SCENARIOS, PRERENDERED_SCENARIOS, calibrationSources } from "./review-calibration-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/review-calibration");
const output = resolve(process.argv[2] ?? "/tmp/visp-review-calibration-inputs");
const configPath = process.argv[3];
if (!configPath) throw new Error("Supply a JSON critic configuration as the third argument; no model is selected implicitly.");
const reviewer = JSON.parse(await readFile(resolve(configPath), "utf8"));
// Fourth argument: "all" (default, seven scenarios), a comma-separated scenario list, or the older
// single game name (fowl-play or flockshot), which keeps the original three scenarios.
const choice = process.argv[4] ?? "all";
const scenarios = choice === "all" ? CALIBRATION_SCENARIOS
  : ["fowl-play", "flockshot"].includes(choice) ? [choice, "booking", "checkout"] : choice.split(",");
for (const scenario of scenarios) if (!CALIBRATION_SCENARIOS.includes(scenario)) throw new Error("Unknown calibration scenario " + scenario);
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "visp-calibration-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = [];
try {
  for (const scenario of scenarios) {
    for (const variant of ["defective", "control"]) {
      const id = scenario + "-" + variant;
      if (PRERENDERED_SCENARIOS.includes(scenario)) {
        // Frozen images and their recorded operations; see freeze-review-calibration-fixtures.mjs.
        const source = join(fixtures, scenario);
        const assets = [];
        for (const file of (await readdir(source)).filter((name) => name.startsWith(variant + "-") && (name.endsWith(".png") || name.endsWith("-execution.json"))).sort()) {
          const destination = join(output, id + file.slice(variant.length));
          await copyFile(join(source, file), destination);
          assets.push(destination);
        }
        if (assets.length < 2) throw new Error("Missing frozen calibration images for " + id + "; run freeze-review-calibration-fixtures.mjs");
        cases.push({ id, scenario, variant, promptFile: join(source, "prompt.md"), assets, oracleFile: join(source, variant + "-oracle.json") });
        continue;
      }
      // Native operation URLs must not reveal defective/control labels to the reviewer.
      const directory = await mkdtemp(join(temporary, "case-"));
      const sourceFiles = await calibrationSources(root, scenario, variant);
      for (const [file, code] of Object.entries(sourceFiles)) await writeFile(join(directory, file), code);
      const inputFiles = Object.entries(sourceFiles).map(([file, code]) => ({ file, sha256: hash(code) }));
      const session = await openBrowserSession({ directory: join(directory, "captures"), fileRoot: directory,
        subjectDigest: hash(JSON.stringify(inputFiles)), viewport: { width: 1280, height: scenario === "catapult-preview" ? 800 : 720 } });
      const assets = [];
      try {
        await session.navigate(pathToFileURL(join(directory, "index.html")).href);
        const capture = async (state) => {
          const image = await session.capture();
          const destination = join(output, id + "-" + state + ".png");
          await copyFile(image.path, destination);
          assets.push(destination);
        };
        if (scenario === "fowl-play") await activateControl(session.page, "#startButton", "pointer");
        await capture("initial");
        if (scenario === "catapult-preview") {
          // Press the loaded stone at the sling and pull back. The pointer is moved to the full pull before the held
          // capture, then released there, so the preview and the launch come from the same pull.
          const box = await session.page.evaluate(() => { const rect = document.querySelector("#game").getBoundingClientRect(); return { left: rect.left, top: rect.top, scale: rect.width / 1200 }; });
          const world = (x, y) => ({ x: Math.round(box.left + x * box.scale), y: Math.round(box.top + y * box.scale) });
          const from = world(157, 456), to = world(157 - 57, 456 + 14);
          await session.drag({ from, to, input: "pointer", steps: 8, durationMs: 240 }, async () => {
            await session.page.mouse.move(to.x, to.y);
            await new Promise((resolve) => setTimeout(resolve, 80));
            await capture("held");
          });
          const releasedAt = Date.now();
          for (const delay of [150, 350]) {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, releasedAt + delay - Date.now())));
            await capture("released-" + delay + "ms");
          }
        } else if (scenario === "flockshot") {
          await session.page.mouse.click(514, 368);
          await new Promise((resolve) => setTimeout(resolve, 400));
          await capture("released");
        } else if (scenario === "fowl-play") {
          // Stay above the ground so an immediate bounce cannot conceal the launch direction.
          await session.drag({ from: { x: 184, y: 550 }, to: { x: 112, y: 570 }, input: "pointer", steps: 8, durationMs: 240 }, () => capture("held"));
          await new Promise((resolve) => setTimeout(resolve, 80));
          await capture("released");
        }
        const executionPath = join(output, id + "-execution.json");
        await writeFile(executionPath, JSON.stringify({ inputs: inputFiles, operations: session.operations, provenance: "runner-observed" }, null, 2));
        assets.push(executionPath);
      } finally { await session.close(); }
      cases.push({ id, scenario, variant, promptFile: join(fixtures, scenario, "prompt.md"), assets, oracleFile: join(fixtures, scenario, variant + "-oracle.json") });
    }
  }
  await writeFile(join(output, "spec.json"), JSON.stringify({ reviewer, cases }, null, 2));
  console.log(join(output, "spec.json"));
} finally { await rm(temporary, { recursive: true, force: true }); }
