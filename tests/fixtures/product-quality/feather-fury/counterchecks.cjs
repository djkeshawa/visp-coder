// Read-only audit of frozen game functions. No browser, real timers, or game writes.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

function fresh() {
  const elements = new Map();
  const timers = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      width: 960, height: 540, dataset: {}, style: {}, textContent: '',
      handlers: {}, classList: { add() {}, remove() {}, toggle() {} },
      getContext() { return {}; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this[name] = value; },
      focus() {}, blur() {}, setPointerCapture() {}, releasePointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; },
    });
    return elements.get(id);
  }
  const sandbox = { document: { querySelector: element }, Math, Set };
  sandbox.window = {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'game-core.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8') + '\n globalThis.audit = { state, SLING, startRound, resetToMenu, setAim, launchBird, handleKeyboard, endShot, handlePigImpacts, handleStructureImpacts, simulate, handleResultAction };', sandbox);
  return { ...sandbox.audit, physics: sandbox.window.FuryPhysics, elements, timers };
}

const results = [];
function record(name, run) { results.push({ name, ...run() }); }
const key = () => ({ key: ' ', code: 'Space', preventDefault() {} });

record('Down-left pull launches down-right instead of up-right', () => {
  const a = fresh(); a.startRound(); a.setAim({ x: 88, y: 438 }); a.launchBird();
  const { vx, vy } = a.state.projectile;
  assert.ok(vx > 0 && vy > 0);
  return { issueReproduced: true, pull: { x: -64, y: 48 }, velocity: { vx, vy }, expectedVerticalSign: 'negative (up)' };
});

record('Second consecutive Space launch consumes a bird with zero launch velocity', () => {
  const a = fresh(); a.startRound(); a.handleKeyboard(key());
  const first = { vx: a.state.projectile.vx, vy: a.state.projectile.vy };
  a.endShot(); a.handleKeyboard(key());
  const second = { vx: a.state.projectile.vx, vy: a.state.projectile.vy };
  assert.equal(second.vx, 0); assert.equal(second.vy, 0); assert.equal(a.state.birdsRemaining, 2);
  return { issueReproduced: true, first, second, birdsRemaining: a.state.birdsRemaining };
});

record('Pending victory timer overrides reset with a false level-clear result', () => {
  const a = fresh(); a.startRound();
  a.state.pigs[0].alive = false;
  const pig = a.state.pigs[1];
  a.state.projectile = { x: pig.x, y: pig.y, radius: 22, vx: 100, vy: 0, hitTargets: new Set() };
  a.handlePigImpacts(); assert.equal(a.timers.length, 1);
  a.resetToMenu(); assert.equal(a.state.screen, 'menu');
  a.timers[0].callback();
  assert.equal(a.state.screen, 'result'); assert.equal(a.state.pendingResult, 'level');
  assert.equal(a.state.pigs.filter(p => p.alive).length, 2);
  return { issueReproduced: true, delayMs: a.timers[0].delay, screenAfterResetAndTimer: a.state.screen, result: a.state.pendingResult, livingPigs: 2 };
});

record('The same bird ignores a second contact with an intact block', () => {
  const a = fresh(); a.startRound(); const block = a.state.blocks[0];
  a.state.blocks = [block];
  const incoming = { x: block.x - 10, y: block.y + block.height / 2, radius: 22, vx: 100, vy: 0, hitTargets: new Set() };
  a.state.projectile = incoming; a.handleStructureImpacts();
  assert.equal(block.broken, false); assert.ok(a.state.projectile.vx < 0);
  const damage = block.damage;
  // A later return to the same contact after separation, using the same projectile.
  a.state.projectile.x = block.x - 10; a.state.projectile.y = block.y + block.height / 2; a.state.projectile.vx = 100;
  assert.equal(a.physics.circleRectCollision(a.state.projectile, block).hit, true);
  a.handleStructureImpacts();
  assert.equal(a.state.projectile.vx, 100); assert.equal(block.damage, damage);
  return { issueReproduced: true, secondContactStillOverlapping: a.physics.circleRectCollision(a.state.projectile, block).hit, velocityAfterSecondContact: a.state.projectile.vx, blockBroken: block.broken };
});

record('Pointer cancellation fires the bird instead of cancelling aim', () => {
  const a = fresh(); a.startRound();
  const canvas = a.elements.get('#gameCanvas');
  canvas.handlers.pointerdown({ clientX: 88, clientY: 438, pointerId: 1, preventDefault() {} });
  canvas.handlers.pointercancel({ pointerId: 1, preventDefault() {} });
  assert.ok(a.state.projectile); assert.equal(a.state.birdsRemaining, 3);
  return { issueReproduced: true, birdsRemainingAfterCancellation: a.state.birdsRemaining };
});

record('Independent countercheck: diagonal collision reflection is correct', () => {
  const a = fresh();
  const r = a.physics.resolveCircleRectCollision({ x: 95, y: 95, radius: 10 }, { x: 100, y: 100 }, { x: 100, y: 100, width: 20, height: 20 });
  assert.ok(r.velocity.x < 0 && r.velocity.y < 0);
  return { passed: true, velocity: r.velocity };
});

record('Independent countercheck: normal successful-hit timer produces consistent score and next level', () => {
  const a = fresh(); a.startRound(); a.state.pigs[0].alive = false;
  const pig = a.state.pigs[1]; a.state.projectile = { x: pig.x, y: pig.y, radius: 22, vx: 100, vy: 0, hitTargets: new Set() };
  a.handlePigImpacts(); a.timers[0].callback();
  const hud = a.elements.get('#scoreValue').textContent;
  assert.ok(a.elements.get('#resultCopy').textContent.includes(hud));
  a.handleResultAction(); assert.equal(a.state.levelIndex, 1); assert.equal(a.state.screen, 'playing');
  return { passed: true, hudScore: hud, nextLevel: a.state.levelIndex + 1, note: 'Captured score mismatch has not been reproduced by this normal source path.' };
});

console.log(JSON.stringify(results, null, 2));
