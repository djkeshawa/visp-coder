import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const fixture = new URL("../fixtures/product-quality/flockshot-release-regression/", import.meta.url);
test("Flockshot's six weak tests pass while its structure remains disconnected", () => {
  const output = execFileSync(process.execPath, ["--test", fileURLToPath(new URL("test/game.test.mjs", fixture))], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.match(output, /(?:pass 6|tests 6)/);
  const { GameEngine } = require(fileURLToPath(new URL("game.js", fixture)));
  const engine = new GameEngine();
  const [left, right, beam] = engine.blocks;
  assert.equal(left.y - (beam.y + beam.h), 18);
  assert.equal(right.y - (beam.y + beam.h), 18);
  assert.ok(beam.x > left.x + left.w);
  const before = engine.blocks.map(({ x, y }) => [x, y]);
  engine.launchAt(500, 190);
  for (let frame = 0; frame < 120; frame++) engine.step(1 / 60);
  assert.deepEqual(engine.blocks.map(({ x, y }) => [x, y]), before);
});
