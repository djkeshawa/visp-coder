// Offline capture preparation. Uses the installed browser in an isolated, sandboxed profile.
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { activateControl, openBrowserSession } from "../dist/testing.js";
import { calibrationSources } from "./review-calibration-fixtures.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/review-calibration");
const output = resolve(process.argv[2] ?? "/tmp/visp-review-calibration-inputs");
const configPath = process.argv[3];
if (!configPath) throw new Error("Supply a JSON critic configuration as the third argument; no model is selected implicitly.");
const reviewer = JSON.parse(await readFile(resolve(configPath), "utf8"));
const game = process.argv[4] ?? "fowl-play";
if (!["fowl-play", "flockshot"].includes(game)) throw new Error("Choose fowl-play or flockshot as the game scenario");
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "visp-calibration-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = [];
try {
  for (const scenario of [game, "booking", "checkout"]) {
    for (const variant of ["defective", "control"]) {
      const id = scenario + "-" + variant;
      // Native operation URLs must not reveal defective/control labels to the reviewer.
      const directory = await mkdtemp(join(temporary, "case-"));
      const sourceFiles = await calibrationSources(root, scenario, variant);
      for (const [file, code] of Object.entries(sourceFiles)) await writeFile(join(directory, file), code);
      const inputFiles = Object.entries(sourceFiles).map(([file, code]) => ({ file, sha256: hash(code) }));
      const session = await openBrowserSession({ directory: join(directory, "captures"), fileRoot: directory,
        subjectDigest: hash(JSON.stringify(inputFiles)), viewport: { width: 1280, height: 720 } });
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
        if (scenario === "flockshot") {
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
        await writeFile(executionPath, JSON.stringify({ inputs: inputFiles, operations: session.operations, provenance: "runner-observed", observedScope: ["flockshot", "fowl-play"].includes(scenario) ? "first structure and pre-impact release" : "displayed form and summary" }, null, 2));
        assets.push(executionPath);
      } finally { await session.close(); }
      cases.push({ id, scenario, variant, promptFile: join(fixtures, scenario, "prompt.md"), assets, oracleFile: join(fixtures, scenario, variant + "-oracle.json") });
    }
  }
  await writeFile(join(output, "spec.json"), JSON.stringify({ reviewer, cases }, null, 2));
  console.log(join(output, "spec.json"));
} finally { await rm(temporary, { recursive: true, force: true }); }
