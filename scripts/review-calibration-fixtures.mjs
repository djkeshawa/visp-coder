import { readFile } from "node:fs/promises";
import { join } from "node:path";

function replaceOnce(code, original, replacement) {
  if (code.split(original).length !== 2) throw new Error("Frozen calibration source changed; review the scoped control patch");
  return code.replace(original, replacement);
}

/** Scenarios whose images are rendered once by freeze-review-calibration-fixtures.mjs and copied as is. */
export const PRERENDERED_SCENARIOS = ["slingshot-preview", "catapult-finish"];
export const CALIBRATION_SCENARIOS = [
  "fowl-play", "flockshot", "booking", "checkout", "catapult-preview", ...PRERENDERED_SCENARIOS,
];

/** Patches fixture copies only. Controls cover specified states, never whole-product quality. */
export async function calibrationSources(root, scenario, variant) {
  if (!["defective", "control"].includes(variant)) throw new Error("Unknown calibration variant");
  if (!["flockshot", "fowl-play", "booking", "checkout", "catapult-preview"].includes(scenario)) throw new Error("Unknown calibration scenario");
  if (["booking", "checkout"].includes(scenario)) {
    return { "index.html": await readFile(join(root, "tests/fixtures/review-calibration", scenario, variant + ".html"), "utf8") };
  }
  const directory = join(root, "tests/fixtures/product-quality", { flockshot: "flockshot-release-regression", "catapult-preview": "catapult-preview-regression" }[scenario] ?? "fowl-play-review-regression");
  const extra = { "fowl-play": ["game-core.js"], "catapult-preview": ["styles.css"] }[scenario] ?? [];
  const files = Object.fromEntries(await Promise.all(["index.html", "game.js", ...extra].map(async (file) => [file, await readFile(join(directory, file), "utf8")])));
  if (variant === "defective") return files;
  if (scenario === "catapult-preview") {
    // The dotted preview starts at the sling, where launchLoaded() spawns the projectile, not at the pulled ball.
    for (const [original, replacement] of [
      ["const px = x + vx * t;", "const px = SLING_X + vx * t;"],
      ["const py = y + vy * t + 0.5 * GRAVITY * t * t;", "const py = SLING_Y + vy * t + 0.5 * GRAVITY * t * t;"],
    ]) files["game.js"] = replaceOnce(files["game.js"], original, replacement);
  } else if (scenario === "flockshot") {
    for (const [original, replacement] of [
      ["const bird = engine.bird;\n    ctx.save();", 'const bird = engine.state === "ready" ? engine.bird : ORIGIN;\n    ctx.save();'],
      ["{ x: 695, y: 326, w: 150, h: 24", "{ x: 620, y: 344, w: 178, h: 24"],
      ["{ x: 693, y: 270, w: 28, h: 70", "{ x: 693, y: 274, w: 28, h: 70"],
      ["{ x: 770, y: 270, w: 28, h: 70", "{ x: 770, y: 274, w: 28, h: 70"],
    ]) files["game.js"] = replaceOnce(files["game.js"], original, replacement);
  } else {
    for (const [original, replacement] of [
      ["vy: (releasePoint.y - anchor.y) * power", "vy: (anchor.y - releasePoint.y) * power"],
      ['x: clusterX, y: clusterY, radius: 26', 'x: clusterX + 52, y: layout.groundY - 44, radius: 26'],
      ['x: clusterX + 52, y: clusterY + 28, radius: 26', 'x: clusterX + 122, y: layout.groundY - 44, radius: 26'],
      ['x: clusterX + 52, y: clusterY - 28, radius: 26', 'x: clusterX + 89, y: layout.groundY - 178, radius: 26'],
      ["y: layout.groundY - 54, width: 178", "y: layout.groundY - 18, width: 178"],
      ["x: clusterX + 4, y: layout.groundY - 154", "x: clusterX + 4, y: layout.groundY - 118"],
      ["x: clusterX + 152, y: layout.groundY - 154", "x: clusterX + 152, y: layout.groundY - 118"],
      ["y: layout.groundY - 178, width: 154", "y: layout.groundY - 136, width: 154"],
      ["y: layout.groundY - 210, width: 58", "y: layout.groundY - 152, width: 58"],
    ]) files["game-core.js"] = replaceOnce(files["game-core.js"], original, replacement);
  }
  return files;
}
