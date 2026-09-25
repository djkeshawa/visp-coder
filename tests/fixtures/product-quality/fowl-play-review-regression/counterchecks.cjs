const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("./game-core.js");

function boot() {
  const elements = new Map();
  const events = new Map();
  const viewport = { left: 0, top: 0, width: 1280, height: 720 };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, hidden: false, textContent: "", listeners: new Map(),
      addEventListener(event, fn) { this.listeners.set(event, fn); },
      getContext() { return { setTransform() {} }; },
      getBoundingClientRect() { return viewport; },
      setAttribute() {}, focus() {}, setPointerCapture() {},
    });
    return elements.get(id);
  };
  const window = {
    FowlPlayCore: core, devicePixelRatio: 1,
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() { return 1; }, clearTimeout() {}, requestAnimationFrame() {},
    addEventListener(event, fn) { events.set(event, fn); },
  };
  const sandbox = { window, document: { querySelector: element }, performance: { now: () => 0 } };
  const code = fs.readFileSync(__dirname + "/game.js", "utf8");
  assert.ok(code.endsWith("})();\n"), "Frozen controller closure must remain intact");
  vm.runInNewContext(code.replace(/\}\)\(\);\s*$/, "globalThis.api = { state, startRound, updateFlight, resetRound };})();"), sandbox, { timeout: 1000 });
  return { api: sandbox.api, events, viewport, element };
}

function counterchecks() {
  const results = [];
  const anchor = { x: 184, y: 550 };
  const release = { x: 112, y: 636 };
  const velocity = core.launchVelocity(anchor, release, 6);
  results.push({ id: "vertical-release-direction", expected: { vx: 432, vy: -516 }, actual: velocity,
    reproduced: velocity.vx === 432 && velocity.vy === 516 });

  const level = core.createLevel(1280, 720);
  const [floor, left, , roof, cap] = level.blocks;
  const gaps = { ground: level.layout.groundY - (floor.y + floor.height),
    roof: left.y - (roof.y + roof.height), cap: roof.y - (cap.y + cap.height) };
  results.push({ id: "unsupported-initial-structure", expected: { ground: 0, roof: 0, cap: 0 }, actual: gaps,
    reproduced: gaps.ground === 36 && gaps.roof === 6 && gaps.cap === 16 });

  const { api, events, viewport, element } = boot();
  api.startRound();
  const target = api.state.targets[0];
  api.state.mode = "flight";
  api.state.flyingBird = { ...core.createBird(target.x - 50, target.y, "ruby"), vx: 100, vy: 0, trail: [] };
  api.state.birdsRemaining = 3;
  api.state.birdsUsed = 1;
  api.updateFlight(0.01);
  const afterHit = { remainingTargets: api.state.targets.filter((entry) => entry.alive).length,
    score: api.state.score, roundWon: api.state.roundWon };
  results.push({ id: "single-contact-clears-all-targets", expected: "Assess area damage against the intended challenge; only one collision was supplied",
    actual: afterHit, reproduced: afterHit.remainingTargets === 0 && afterHit.score === 450 && afterHit.roundWon });

  viewport.width = 1000;
  events.get("resize")();
  const afterResize = { remainingTargets: api.state.targets.filter((entry) => entry.alive).length,
    score: api.state.score, roundWon: api.state.roundWon, birdsRemaining: api.state.birdsRemaining };
  results.push({ id: "resize-resurrects-defeated-targets", expected: "Preserve destruction or reset the whole round consistently",
    actual: afterResize, reproduced: afterResize.remainingTargets === 3 && afterResize.score === 450 && afterResize.roundWon && afterResize.birdsRemaining === 3 });

  const horizontal = core.launchVelocity(anchor, { x: 112, y: 550 }, 6);
  assert.equal(horizontal.vx, 432);
  assert.equal(horizontal.vy, 0);
  results.push({ id: "horizontal-launch-control", passed: true });
  element("#replayButton").listeners.get("click")();
  assert.equal(api.state.score, 0);
  assert.equal(api.state.roundWon, false);
  assert.equal(api.state.birdsRemaining, 4);
  results.push({ id: "replay-restores-consistent-round", passed: true });
  for (const result of results) if ("reproduced" in result) assert.equal(result.reproduced, true, result.id);
  return results;
}

module.exports = { counterchecks };
if (require.main === module) console.log(JSON.stringify(counterchecks(), null, 2));
