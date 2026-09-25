import { test } from "node:test";
import assert from "node:assert/strict";

import game from "../game.js";

const {
  GameEngine,
  GROUND_Y,
  ORIGIN,
  circleRectCollision
} = game;

function simpleLevel(name = "Test Island") {
  return {
    name,
    breeze: "calm",
    wind: 0,
    shots: 2,
    blocks: [],
    targets: [{ x: 250, y: 400, r: 40 }]
  };
}

function advanceUntil(engine, states, limit = 700) {
  for (let i = 0; i < limit; i += 1) {
    if (states.includes(engine.state)) return;
    engine.step(1 / 60);
  }
  return engine.state;
}

test("a new engine opens ready with a playable level and visible targets", () => {
  const engine = new GameEngine();

  assert.equal(engine.state, "ready");
  assert.equal(engine.levelIndex, 0);
  assert.equal(engine.getRemainingTargets(), 2);
  assert.equal(engine.shotsLeft, 4);
  assert.equal(engine.snapshot().blocksStanding > 0, true);
});

test("aiming clamps to the sling radius and launch enters flight", () => {
  const engine = new GameEngine();

  assert.equal(engine.setAim(ORIGIN.x - 999, ORIGIN.y + 999), true);
  assert.equal(engine.launch(), true);
  assert.equal(engine.state, "flying");
  assert.equal(engine.shotsLeft, 3);
  assert.equal(Math.hypot(engine.bird.x - ORIGIN.x, engine.bird.y - ORIGIN.y) <= 108.001, true);
  assert.equal(engine.bird.vx > 0, true);
  assert.equal(engine.bird.vy < 0, true);
});

test("a fast flight can break a target, award score, and clear the island", () => {
  const engine = new GameEngine({ levels: [simpleLevel()] });

  engine.setAim(80, 420);
  assert.equal(engine.launch(), true);
  advanceUntil(engine, ["won", "lost"]);

  assert.equal(engine.state, "won");
  assert.equal(engine.getRemainingTargets(), 0);
  assert.equal(engine.score >= 150, true);
  assert.equal(engine.shotsLeft, 1);
});

test("clearing a level unlocks the next level and reset restores its shot state", () => {
  const engine = new GameEngine({ levels: [simpleLevel("One"), simpleLevel("Two")] });

  engine.setAim(80, 420);
  engine.launch();
  advanceUntil(engine, ["won", "lost"]);
  assert.equal(engine.state, "won");
  assert.equal(engine.nextLevel(), true);
  assert.equal(engine.levelIndex, 1);
  assert.equal(engine.state, "ready");
  assert.equal(engine.shotsLeft, 2);
  assert.equal(engine.getRemainingTargets(), 1);

  engine.launchAt(480, 120);
  assert.equal(engine.state, "flying");
  engine.resetCurrent();
  assert.equal(engine.state, "ready");
  assert.equal(engine.shotsLeft, 2);
  assert.equal(engine.getRemainingTargets(), 1);
});

test("running out of shots produces a loss state without throwing", () => {
  const level = {
    name: "Long Odds",
    breeze: "calm",
    wind: 0,
    shots: 1,
    blocks: [],
    targets: [{ x: 900, y: 120, r: 18 }]
  };
  const engine = new GameEngine({ levels: [level] });

  engine.launchAt(300, 80);
  advanceUntil(engine, ["lost", "won"], 1000);

  assert.equal(engine.state, "lost");
  assert.equal(engine.shotsLeft, 0);
  assert.equal(engine.resetCurrent().state, "ready");
  assert.equal(engine.shotsLeft, 1);
});

test("circle-to-rectangle collision returns a useful separating normal", () => {
  const hit = circleRectCollision(
    { x: 50, y: 50, r: 12 },
    { x: 58, y: 40, w: 35, h: 30 }
  );

  assert.notEqual(hit, null);
  assert.equal(hit.normal.x < 0, true);
  assert.equal(hit.depth > 0, true);
  assert.equal(GROUND_Y > ORIGIN.y, true);
});
