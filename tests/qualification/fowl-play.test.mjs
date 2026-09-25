import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { calibrationSources } from "../../scripts/review-calibration-fixtures.mjs";

const fixture = new URL("../fixtures/product-quality/fowl-play-review-regression/", import.meta.url);
const require = createRequire(import.meta.url);

test("Fowl Play original bytes and all eight weak checks survive the independent counterexamples", () => {
  const provenance = JSON.parse(readFileSync(new URL("provenance.json", fixture), "utf8"));
  for (const [file, expected] of Object.entries(provenance.files)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, fixture))).digest("hex"), expected, file);
  }
  const output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", fileURLToPath(new URL("tests/game-core.test.mjs", fixture))], {
    encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 10000,
  });
  assert.match(output, /# pass 8/);
  const { counterchecks } = require(fileURLToPath(new URL("counterchecks.cjs", fixture)));
  const results = counterchecks();
  assert.equal(results.filter((entry) => entry.reproduced).length, 4);
  assert.equal(results.filter((entry) => entry.passed).length, 2);
});

test("the scoped control corrects launch direction and surface contact without rewriting the frozen original", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const defective = await calibrationSources(root, "fowl-play", "defective");
  const control = await calibrationSources(root, "fowl-play", "control");
  assert.equal(defective["game-core.js"], readFileSync(new URL("game-core.js", fixture), "utf8"));
  assert.equal(control["game.js"], defective["game.js"]);
  assert.equal(control["index.html"], defective["index.html"]);
  const sandbox = {};
  runInNewContext(control["game-core.js"], sandbox);
  const core = sandbox.FowlPlayCore;
  const level = core.createLevel(1280, 720);
  assert.equal(core.launchVelocity(level.layout.sling, { x: 112, y: 636 }, 6).vy, -516);
  const [floor, left, right, roof, cap] = level.blocks;
  assert.equal(floor.y + floor.height, level.layout.groundY);
  assert.equal(left.y + left.height, floor.y);
  assert.equal(right.y + right.height, floor.y);
  assert.equal(roof.y + roof.height, left.y);
  assert.equal(cap.y + cap.height, roof.y);
  assert.ok(level.targets.every((target) => level.blocks.some((block) =>
    target.y + target.radius === block.y && target.x >= block.x && target.x <= block.x + block.width)));
});
