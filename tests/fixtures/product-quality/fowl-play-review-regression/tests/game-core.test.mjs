import assert from "node:assert/strict";
import test from "node:test";
import core from "../game-core.js";

test("layout keeps the desktop sling at the captured launch coordinates", () => {
  const layout = core.getLayout(1280, 720);
  assert.deepEqual(layout.sling, { x: 184, y: 550 });
  assert.equal(layout.groundY, 622);
});

test("mobile layout keeps an accessible sling inside the viewport", () => {
  const layout = core.getLayout(390, 844);
  assert.deepEqual(layout.sling, { x: 96, y: 684 });
  assert.ok(layout.groundY < layout.height);
});

test("aiming clamps the bird to the sling stretch radius", () => {
  const point = core.clampAim({ x: 184, y: 550 }, { x: 20, y: 320 }, 120);
  assert.ok(Math.abs(Math.hypot(point.x - 184, point.y - 550) - 120) < 0.0001);
});

test("launch velocity points opposite the pull direction", () => {
  const velocity = core.launchVelocity({ x: 184, y: 550 }, { x: 112, y: 464 }, 6);
  assert.deepEqual(velocity, { vx: 432, vy: -516 });
});

test("stepBody advances position and applies gravity", () => {
  const body = { x: 0, y: 0, vx: 100, vy: -200 };
  core.stepBody(body, 0.5, 900);
  assert.deepEqual(body, { x: 50, y: -100, vx: 100, vy: 250 });
});

test("circle and rectangle collision helpers detect contact at an edge", () => {
  assert.equal(
    core.circleIntersectsCircle({ x: 0, y: 0, radius: 10 }, { x: 20, y: 0, radius: 10 }),
    true,
  );
  assert.equal(
    core.circleIntersectsRect({ x: 15, y: 10, radius: 5 }, { x: 0, y: 0, width: 10, height: 20 }),
    true,
  );
});

test("the authored level gives targets a compact combo radius", () => {
  const level = core.createLevel(1280, 720);
  assert.equal(level.targets.length, 3);
  assert.ok(level.targets.every((target) => core.distance(level.targets[0], target) < 100));
  assert.equal(level.blocks.length, 5);
});

test("out-of-bounds bodies are safe to retire", () => {
  assert.equal(core.isOutOfBounds({ x: 1300, y: 200 }, 1280, 720), false);
  assert.equal(core.isOutOfBounds({ x: 1420, y: 200 }, 1280, 720), true);
  assert.equal(core.isOutOfBounds({ x: 200, y: 900 }, 1280, 720), true);
});
