(function bootstrap(root, createApi) {
  const api = createApi();

  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Flockshot = api;
  if (root && root.document) {
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", () => api.mount(root.document), { once: true });
    } else {
      api.mount(root.document);
    }
  }
})(typeof globalThis === "object" ? globalThis : this, function createFlockshotApi() {
  "use strict";

  const WIDTH = 1000;
  const HEIGHT = 560;
  const GROUND_Y = 484;
  const GRAVITY = 575;
  const MAX_PULL = 122;
  const DEFAULT_BIRDS = 4;
  const MAX_PARTICLES = 230;

  const MATERIALS = {
    wood: { fill: "#a96d4a", edge: "#613f3e", grain: "#d99965" },
    stone: { fill: "#82819a", edge: "#4d5270", grain: "#b9b4c2" },
    ice: { fill: "#9cd5d4", edge: "#477e96", grain: "#daf3e7" },
  };

  const LEVELS = [
    {
      name: "Taffy Towers",
      subtitle: "Two bubble bandits. One suspiciously tall snack shack.",
      targets: [
        { x: 808, y: 356, radius: 24, color: "#9ed9b5", accent: "#f7c24f", variant: "cap" },
        { x: 903, y: 405, radius: 23, color: "#a8d8c0", accent: "#ee6d52", variant: "band" },
      ],
      blocks: [
        { x: 744, y: 410, width: 24, height: 66, material: "wood", health: 5, angle: -0.03 },
        { x: 891, y: 410, width: 24, height: 66, material: "wood", health: 5, angle: 0.03 },
        { x: 744, y: 391, width: 171, height: 20, material: "wood", health: 6, angle: 0 },
        { x: 795, y: 334, width: 25, height: 63, material: "wood", health: 4, angle: 0.02 },
        { x: 859, y: 334, width: 25, height: 63, material: "wood", health: 4, angle: -0.02 },
        { x: 795, y: 314, width: 89, height: 19, material: "ice", health: 5, angle: 0 },
      ],
    },
    {
      name: "Moonmilk Mill",
      subtitle: "A sleepy mill, three bandits, and one very rude windmill.",
      targets: [
        { x: 778, y: 405, radius: 23, color: "#b6e3bc", accent: "#ee6d52", variant: "band" },
        { x: 866, y: 343, radius: 24, color: "#9ed9b5", accent: "#f7c24f", variant: "cap" },
        { x: 934, y: 405, radius: 22, color: "#b6e3bc", accent: "#9e8be1", variant: "star" },
      ],
      blocks: [
        { x: 744, y: 411, width: 22, height: 65, material: "stone", health: 7, angle: 0 },
        { x: 845, y: 411, width: 22, height: 65, material: "stone", health: 7, angle: 0 },
        { x: 918, y: 411, width: 22, height: 65, material: "stone", health: 7, angle: 0 },
        { x: 744, y: 392, width: 123, height: 20, material: "ice", health: 4, angle: 0.01 },
        { x: 845, y: 369, width: 95, height: 20, material: "wood", health: 5, angle: -0.02 },
        { x: 845, y: 348, width: 20, height: 21, material: "wood", health: 3, angle: 0 },
        { x: 918, y: 392, width: 22, height: 20, material: "wood", health: 4, angle: 0 },
        { x: 820, y: 305, width: 24, height: 65, material: "wood", health: 4, angle: 0.03 },
        { x: 885, y: 305, width: 24, height: 65, material: "wood", health: 4, angle: -0.03 },
        { x: 820, y: 284, width: 89, height: 20, material: "ice", health: 5, angle: 0 },
      ],
    },
    {
      name: "The Cloud Keep",
      subtitle: "The last nest is wrapped in ice. Make a spectacular mess.",
      targets: [
        { x: 790, y: 395, radius: 22, color: "#b8e2bc", accent: "#f7c24f", variant: "cap" },
        { x: 864, y: 330, radius: 23, color: "#a8d8c0", accent: "#ee6d52", variant: "band" },
        { x: 929, y: 273, radius: 21, color: "#b8e2bc", accent: "#9e8be1", variant: "star" },
        { x: 951, y: 405, radius: 22, color: "#a8d8c0", accent: "#f7c24f", variant: "cap" },
      ],
      blocks: [
        { x: 753, y: 411, width: 21, height: 65, material: "ice", health: 5, angle: -0.02 },
        { x: 820, y: 411, width: 21, height: 65, material: "stone", health: 7, angle: 0.02 },
        { x: 925, y: 411, width: 21, height: 65, material: "ice", health: 5, angle: 0 },
        { x: 753, y: 391, width: 89, height: 20, material: "wood", health: 4, angle: 0 },
        { x: 903, y: 391, width: 64, height: 20, material: "wood", health: 4, angle: 0 },
        { x: 803, y: 347, width: 21, height: 64, material: "wood", health: 4, angle: 0.02 },
        { x: 865, y: 347, width: 21, height: 64, material: "wood", health: 4, angle: -0.02 },
        { x: 803, y: 326, width: 83, height: 20, material: "ice", health: 5, angle: 0 },
        { x: 885, y: 289, width: 21, height: 102, material: "stone", health: 8, angle: 0.02 },
        { x: 934, y: 347, width: 21, height: 44, material: "wood", health: 3, angle: -0.04 },
        { x: 875, y: 268, width: 76, height: 21, material: "ice", health: 5, angle: 0 },
      ],
    },
  ];

  const STARS = [
    [72, 82, 1.3], [141, 154, 1], [214, 70, 1.8], [287, 124, 1.1], [374, 57, 1.2],
    [458, 143, 1.5], [538, 81, 0.8], [632, 136, 1.5], [710, 54, 1], [822, 148, 1.4],
    [907, 88, 0.9], [958, 171, 1.7], [52, 223, 0.8], [166, 252, 1.2], [328, 208, 0.8],
    [613, 227, 1], [748, 211, 0.8], [879, 235, 1.2],
  ];

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function createBird(anchor) {
    return {
      position: { x: anchor.x, y: anchor.y },
      velocity: { x: 0, y: 0 },
      radius: 23,
      rotation: 0,
      active: true,
      trail: [],
    };
  }

  function copyLevel(level) {
    return {
      name: level.name,
      subtitle: level.subtitle,
      targets: level.targets.map((target) => ({ ...target, alive: true })),
      blocks: level.blocks.map((block) => ({
        ...block,
        alive: true,
        maxHealth: block.health,
      })),
    };
  }

  function createState(levelIndex = 0) {
    const safeLevel = clamp(Math.floor(levelIndex), 0, LEVELS.length - 1);
    const anchor = { x: 145, y: 427 };
    const level = copyLevel(LEVELS[safeLevel]);

    return {
      levelIndex: safeLevel,
      phase: "ready",
      score: 0,
      levelScore: 0,
      maxBirds: DEFAULT_BIRDS,
      birdsLeft: DEFAULT_BIRDS,
      shotsUsed: 0,
      sling: { anchor, maxPull: MAX_PULL },
      bird: createBird(anchor),
      targets: level.targets,
      blocks: level.blocks,
      particles: [],
      floaters: [],
      events: [],
      aim: null,
      elapsed: 0,
      shotTime: 0,
      camera: { shake: 0 },
      message: "Pick a pocket of sky and fling.",
      bonusAwarded: false,
      soundEnabled: true,
      reducedMotion: false,
    };
  }

  function getLevel(state) {
    return LEVELS[state.levelIndex];
  }

  function getAimPoint(state, pointer) {
    const anchor = state.sling.anchor;
    const requested = pointer || state.aim || { x: anchor.x - 82, y: anchor.y - 35 };
    const vector = { x: requested.x - anchor.x, y: requested.y - anchor.y };
    const length = Math.hypot(vector.x, vector.y);
    if (length === 0) return { x: anchor.x, y: anchor.y };
    const amount = Math.min(length, state.sling.maxPull);
    return {
      x: anchor.x + (vector.x / length) * amount,
      y: anchor.y + (vector.y / length) * amount,
    };
  }

  function getLaunchVelocity(state, aim) {
    const pull = {
      x: state.sling.anchor.x - aim.x,
      y: state.sling.anchor.y - aim.y,
    };
    return { x: pull.x * 7.7, y: pull.y * 7.7 };
  }

  function setAim(state, pointer) {
    if (state.phase !== "ready" && state.phase !== "aiming") return false;
    state.aim = getAimPoint(state, pointer);
    state.bird.position = { ...state.aim };
    state.bird.velocity = { x: 0, y: 0 };
    state.phase = "aiming";
    state.message = "Angle locked. Release to fling.";
    return true;
  }

  function cancelAim(state) {
    state.phase = "ready";
    state.aim = null;
    state.bird.position = { ...state.sling.anchor };
    state.message = "Pick a pocket of sky and fling.";
    return state;
  }

  function previewTrajectory(state, pointer, count = 12) {
    const aim = getAimPoint(state, pointer);
    const velocity = getLaunchVelocity(state, aim);
    const points = [];
    const steps = Math.max(1, Math.floor(count));

    for (let index = 1; index <= steps; index += 1) {
      const time = index * 0.055;
      points.push({
        x: aim.x + velocity.x * time,
        y: aim.y + velocity.y * time + 0.5 * GRAVITY * time * time,
      });
    }
    return points;
  }

  function markLaunch(state, velocity, position) {
    state.bird.position = { ...position };
    state.bird.velocity = { ...velocity };
    state.bird.rotation = 0;
    state.bird.trail = [];
    state.bird.active = true;
    state.aim = null;
    state.phase = "flying";
    state.shotTime = 0;
    state.birdsLeft = Math.max(0, state.birdsLeft - 1);
    state.shotsUsed += 1;
    state.message = "Watch the arc. Chase the sparkle.";
    state.events.push({ kind: "launch" });
  }

  function launch(state, pointer) {
    if (state.phase !== "ready" && state.phase !== "aiming") return false;
    const aim = getAimPoint(state, pointer);
    if (distance(aim, state.sling.anchor) < 8) return false;
    markLaunch(state, getLaunchVelocity(state, aim), aim);
    return true;
  }

  function launchToward(state, target) {
    if (state.phase !== "ready" && state.phase !== "aiming") return false;
    const anchor = state.sling.anchor;
    const vector = { x: target.x - anchor.x, y: target.y - anchor.y };
    const length = Math.hypot(vector.x, vector.y);
    if (length < 5) return false;
    const power = clamp(650 + length * 0.18, 680, 850);
    markLaunch(state, { x: (vector.x / length) * power, y: (vector.y / length) * power }, anchor);
    return true;
  }

  function aimWithKeyboard(state, delta) {
    if (state.phase !== "ready" && state.phase !== "aiming") return false;
    const current = state.aim || {
      x: state.sling.anchor.x - 82,
      y: state.sling.anchor.y + 36,
    };
    return setAim(state, { x: current.x + delta.x, y: current.y + delta.y });
  }

  function circleTouchesRect(circle, rectangle) {
    const closestX = clamp(circle.x, rectangle.x, rectangle.x + rectangle.width);
    const closestY = clamp(circle.y, rectangle.y, rectangle.y + rectangle.height);
    return Math.hypot(circle.x - closestX, circle.y - closestY) <= circle.radius;
  }

  function emitImpact(state, x, y, color, label, points, kind) {
    state.score += points;
    state.levelScore += points;
    state.floaters.push({ x, y, text: `+${points}`, color, life: 1.25, maxLife: 1.25 });
    spawnBurst(state, x, y, color, kind === "target" ? 28 : 16);
    state.camera.shake = Math.max(state.camera.shake, kind === "target" ? 11 : 6);
    state.events.push({ kind });
    state.message = label;
  }

  function hitTargets(state) {
    const bird = state.bird;
    for (const target of state.targets) {
      if (!target.alive) continue;
      const hit = distance(bird.position, target) <= bird.radius + target.radius;
      if (!hit) continue;
      target.alive = false;
      emitImpact(state, target.x, target.y, target.accent, "Bandit popped! That was clean.", 500, "target");
      bird.velocity.x *= 0.64;
      bird.velocity.y *= 0.64;
    }
  }

  function hitBlocks(state) {
    const bird = state.bird;
    const speed = Math.hypot(bird.velocity.x, bird.velocity.y);

    for (const block of state.blocks) {
      if (!block.alive || !circleTouchesRect({ ...bird.position, radius: bird.radius }, block)) continue;
      const damage = Math.max(0.75, speed / 190);
      block.health -= damage;
      const points = block.health <= 0 ? 160 : 35;
      const message = block.health <= 0 ? "Splinter shower! Shortcut unlocked." : "Block rattled. Keep going.";
      emitImpact(state, bird.position.x, bird.position.y, MATERIALS[block.material].grain, message, points, "block");
      if (block.health <= 0) block.alive = false;

      const horizontalHit = Math.abs(bird.position.x - (block.x + block.width / 2)) >
        Math.abs(bird.position.y - (block.y + block.height / 2));
      if (horizontalHit) bird.velocity.x *= -0.58;
      else bird.velocity.y *= -0.58;
      bird.position.x += Math.sign(bird.velocity.x || 1) * 4;
      bird.position.y += Math.sign(bird.velocity.y || 1) * 4;
      break;
    }
  }

  function resolveOutcome(state) {
    if (!state.targets.every((target) => !target.alive)) return state;
    if (state.phase === "won" || state.phase === "complete") return state;
    if (!state.bonusAwarded) {
      const bonus = state.birdsLeft * 250;
      if (bonus > 0) {
        state.score += bonus;
        state.levelScore += bonus;
        state.floaters.push({ x: 650, y: 160, text: `+${bonus} bonus`, color: "#ffc857", life: 2.2, maxLife: 2.2 });
      }
      state.bonusAwarded = true;
    }
    state.bird.active = false;
    state.phase = state.levelIndex === LEVELS.length - 1 ? "complete" : "won";
    state.message = state.phase === "complete" ? "Cloudbreakers complete! The sky is yours." : "Island cleared. That was a proper bonk.";
    state.events.push({ kind: "win" });
    spawnConfetti(state);
    return state;
  }

  function finishShot(state) {
    if (state.phase !== "flying") return state;
    state.bird.active = false;
    state.aim = null;
    resolveOutcome(state);
    if (state.phase === "won" || state.phase === "complete") return state;
    if (state.birdsLeft > 0) {
      state.phase = "ready";
      state.bird = createBird(state.sling.anchor);
      state.message = `${state.birdsLeft} bird${state.birdsLeft === 1 ? "" : "s"} left. Find a new weak spot.`;
    } else {
      state.phase = "lost";
      state.message = "The clouds win this round. Reset and try a higher arc.";
      state.events.push({ kind: "lose" });
    }
    return state;
  }

  function updateParticles(state, delta) {
    for (let index = state.particles.length - 1; index >= 0; index -= 1) {
      const particle = state.particles[index];
      particle.life -= delta;
      if (particle.life <= 0) {
        state.particles.splice(index, 1);
        continue;
      }
      particle.vy += particle.gravity * delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.rotation += particle.spin * delta;
    }

    for (let index = state.floaters.length - 1; index >= 0; index -= 1) {
      const floater = state.floaters[index];
      floater.life -= delta;
      floater.y -= delta * 28;
      if (floater.life <= 0) state.floaters.splice(index, 1);
    }
  }

  function step(state, seconds) {
    const delta = clamp(Number(seconds) || 0, 0, 0.05);
    state.elapsed += delta;
    state.camera.shake = Math.max(0, state.camera.shake - delta * 28);
    updateParticles(state, delta);
    if (state.phase !== "flying") return state;

    const bird = state.bird;
    state.shotTime += delta;
    bird.velocity.y += GRAVITY * delta;
    bird.position.x += bird.velocity.x * delta;
    bird.position.y += bird.velocity.y * delta;
    bird.rotation += bird.velocity.x * delta * 0.003;
    if (state.shotTime > 0.04) {
      bird.trail.push({ x: bird.position.x, y: bird.position.y });
      if (bird.trail.length > 20) bird.trail.shift();
    }

    hitTargets(state);
    hitBlocks(state);
    resolveOutcome(state);
    if (state.phase !== "flying") return state;

    if (bird.position.y + bird.radius > GROUND_Y) {
      const impactSpeed = Math.hypot(bird.velocity.x, bird.velocity.y);
      bird.position.y = GROUND_Y - bird.radius;
      bird.velocity.y *= -0.48;
      bird.velocity.x *= 0.74;
      if (impactSpeed > 190) {
        spawnBurst(state, bird.position.x, GROUND_Y, "#f7c24f", 10);
        state.events.push({ kind: "ground" });
      }
    }

    const speed = Math.hypot(bird.velocity.x, bird.velocity.y);
    const outOfBounds = bird.position.x < -130 || bird.position.x > WIDTH + 130 || bird.position.y > HEIGHT + 100;
    if (outOfBounds || (state.shotTime > 0.75 && speed < 72) || state.shotTime > 7) finishShot(state);
    return state;
  }

  function reset(state) {
    const fresh = createState(state.levelIndex);
    fresh.score = state.score;
    fresh.soundEnabled = state.soundEnabled;
    Object.assign(state, fresh);
    return state;
  }

  function restartRun(state) {
    const fresh = createState(0);
    fresh.soundEnabled = state.soundEnabled;
    Object.assign(state, fresh);
    return state;
  }

  function nextLevel(state) {
    if (state.phase !== "won" && state.phase !== "complete") return state;
    if (state.levelIndex >= LEVELS.length - 1) {
      state.phase = "complete";
      return state;
    }
    const fresh = createState(state.levelIndex + 1);
    fresh.score = state.score;
    fresh.soundEnabled = state.soundEnabled;
    Object.assign(state, fresh);
    state.message = `Island ${state.levelIndex + 1} loaded. The bandits look nervous.`;
    return state;
  }

  function spawnBurst(state, x, y, color, count = 18) {
    const safeCount = Math.min(count, MAX_PARTICLES - state.particles.length);
    for (let index = 0; index < safeCount; index += 1) {
      const angle = (Math.PI * 2 * index) / safeCount + state.elapsed * 0.7;
      const speed = 60 + (index % 5) * 22;
      state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 35,
        gravity: 180 + (index % 4) * 30,
        size: 3 + (index % 4),
        color,
        life: 0.65 + (index % 5) * 0.08,
        maxLife: 1,
        rotation: angle,
        spin: (index % 2 ? 1 : -1) * 4,
        star: index % 3 === 0,
      });
    }
  }

  function spawnConfetti(state) {
    const colors = ["#ffc857", "#ee6d52", "#9ed9b5", "#d8b7ef", "#fff9ef"];
    for (let index = 0; index < 48 && state.particles.length < MAX_PARTICLES; index += 1) {
      state.particles.push({
        x: 540 + Math.sin(index * 2.4) * 390,
        y: 120 + (index % 6) * 18,
        vx: Math.sin(index * 1.7) * 35,
        vy: 20 + (index % 5) * 18,
        gravity: 45,
        size: 4 + (index % 3),
        color: colors[index % colors.length],
        life: 2.5 + (index % 4) * 0.2,
        maxLife: 3,
        rotation: index,
        spin: (index % 2 ? 1 : -1) * 5,
        star: false,
      });
    }
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const safeRadius = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
    ctx.beginPath();
    ctx.moveTo(x + safeRadius, y);
    ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
    ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
    ctx.arcTo(x, y + height, x, y, safeRadius);
    ctx.arcTo(x, y, x + width, y, safeRadius);
    ctx.closePath();
  }

  function drawCloud(ctx, x, y, scale, alpha = 0.18) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#fff9ef";
    ctx.beginPath();
    ctx.arc(x, y, 26 * scale, Math.PI, 0);
    ctx.arc(x + 33 * scale, y - 12 * scale, 34 * scale, Math.PI, 0);
    ctx.arc(x + 74 * scale, y - 2 * scale, 25 * scale, Math.PI, 0);
    ctx.lineTo(x + 99 * scale, y + 15 * scale);
    ctx.lineTo(x - 25 * scale, y + 15 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBackground(ctx, state, time) {
    const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    sky.addColorStop(0, "#172052");
    sky.addColorStop(0.58, "#5864a2");
    sky.addColorStop(1, "#ef9b70");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = "rgba(255, 200, 87, 0.42)";
    ctx.shadowBlur = 40;
    ctx.fillStyle = "#ffc857";
    ctx.beginPath();
    ctx.arc(794, 112, 50 + Math.sin(time * 0.7) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    for (const [x, y, size] of STARS) {
      ctx.fillStyle = `rgba(255, 249, 239, ${0.34 + Math.sin(time * 1.4 + x) * 0.12})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    drawCloud(ctx, 96 + Math.sin(time * 0.1) * 10, 180, 0.95, 0.11);
    drawCloud(ctx, 495 - Math.sin(time * 0.08) * 14, 112, 0.62, 0.09);
    drawCloud(ctx, 835 + Math.sin(time * 0.12) * 12, 220, 0.72, 0.13);

    ctx.fillStyle = "rgba(29, 39, 86, 0.32)";
    ctx.beginPath();
    ctx.moveTo(0, 360);
    ctx.lineTo(120, 255);
    ctx.lineTo(230, 344);
    ctx.lineTo(345, 232);
    ctx.lineTo(486, 355);
    ctx.lineTo(626, 245);
    ctx.lineTo(744, 346);
    ctx.lineTo(872, 252);
    ctx.lineTo(1000, 349);
    ctx.lineTo(1000, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    const water = ctx.createLinearGradient(0, 420, 0, HEIGHT);
    water.addColorStop(0, "#386c76");
    water.addColorStop(1, "#1b3a59");
    ctx.fillStyle = water;
    ctx.fillRect(0, 418, WIDTH, HEIGHT - 418);
    ctx.strokeStyle = "rgba(255, 249, 239, 0.2)";
    ctx.lineWidth = 2;
    for (let row = 0; row < 4; row += 1) {
      ctx.beginPath();
      for (let x = -20; x <= WIDTH + 20; x += 40) {
        const y = 438 + row * 32 + Math.sin(x * 0.03 + time * 0.9 + row) * 3;
        if (x === -20) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.fillStyle = "#2c554f";
    ctx.beginPath();
    ctx.moveTo(0, 463);
    ctx.bezierCurveTo(150, 440, 280, 475, 405, 451);
    ctx.bezierCurveTo(544, 425, 660, 467, 806, 447);
    ctx.bezierCurveTo(887, 436, 948, 446, WIDTH, 435);
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#376d55";
    ctx.beginPath();
    ctx.moveTo(0, 482);
    ctx.bezierCurveTo(155, 460, 294, 494, 432, 473);
    ctx.bezierCurveTo(585, 449, 692, 492, 824, 470);
    ctx.bezierCurveTo(910, 457, 962, 470, WIDTH, 458);
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();
  }

  function drawSling(ctx, state) {
    const anchor = state.sling.anchor;
    const bird = state.phase === "aiming" ? state.bird.position : anchor;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(24, 35, 76, 0.35)";
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.moveTo(anchor.x - 21, anchor.y + 47);
    ctx.lineTo(anchor.x - 12, anchor.y - 15);
    ctx.moveTo(anchor.x + 23, anchor.y + 47);
    ctx.lineTo(anchor.x + 11, anchor.y - 15);
    ctx.stroke();
    ctx.strokeStyle = "#704448";
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(anchor.x - 21, anchor.y + 47);
    ctx.lineTo(anchor.x - 12, anchor.y - 15);
    ctx.moveTo(anchor.x + 23, anchor.y + 47);
    ctx.lineTo(anchor.x + 11, anchor.y - 15);
    ctx.stroke();
    ctx.strokeStyle = "#362e48";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(anchor.x - 12, anchor.y - 11);
    ctx.lineTo(bird.x, bird.y);
    ctx.lineTo(anchor.x + 11, anchor.y - 11);
    ctx.stroke();
    ctx.restore();
  }

  function drawTrajectory(ctx, state) {
    if (state.phase !== "aiming" || !state.aim) return;
    const points = previewTrajectory(state, state.aim, 12);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 249, 239, 0.46)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 8]);
    ctx.beginPath();
    ctx.moveTo(state.bird.position.x, state.bird.position.y);
    points.forEach((point) => ctx.lineTo(point.x, point.y));
    ctx.stroke();
    ctx.setLineDash([]);
    points.forEach((point, index) => {
      if (point.x < 0 || point.x > WIDTH || point.y < 0 || point.y > HEIGHT) return;
      ctx.globalAlpha = 0.78 - index * 0.04;
      ctx.fillStyle = "#fff9ef";
      ctx.beginPath();
      ctx.arc(point.x, point.y, index % 3 === 0 ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawBlock(ctx, block) {
    if (!block.alive) return;
    const material = MATERIALS[block.material];
    const healthRatio = clamp(block.health / block.maxHealth, 0, 1);
    ctx.save();
    ctx.translate(block.x + block.width / 2, block.y + block.height / 2);
    ctx.rotate(block.angle || 0);
    ctx.shadowColor = "rgba(15, 24, 61, 0.25)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = material.fill;
    roundedRect(ctx, -block.width / 2, -block.height / 2, block.width, block.height, 5);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = material.edge;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.strokeStyle = material.grain;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.72;
    if (block.material === "wood") {
      ctx.beginPath();
      ctx.moveTo(-block.width / 2 + 5, -block.height / 2 + block.height * 0.34);
      ctx.lineTo(block.width / 2 - 5, -block.height / 2 + block.height * 0.34);
      ctx.moveTo(-block.width / 2 + 5, block.height * 0.16);
      ctx.lineTo(block.width / 2 - 5, block.height * 0.16);
      ctx.stroke();
    } else if (block.material === "ice") {
      ctx.beginPath();
      ctx.moveTo(-block.width / 2 + 4, block.height / 2 - 5);
      ctx.lineTo(block.width / 2 - 4, -block.height / 2 + 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(-block.width * 0.2, -block.height * 0.15, Math.min(block.width, block.height) * 0.14, 0, Math.PI * 2);
      ctx.arc(block.width * 0.24, block.height * 0.2, Math.min(block.width, block.height) * 0.1, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (healthRatio < 0.72) {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#4d3442";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-block.width * 0.18, -block.height * 0.2);
      ctx.lineTo(0, 0);
      ctx.lineTo(-block.width * 0.08, block.height * 0.3);
      ctx.moveTo(0, 0);
      ctx.lineTo(block.width * 0.22, -block.height * 0.23);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTarget(ctx, target, time) {
    if (!target.alive) return;
    const bob = Math.sin(time * 2.5 + target.x) * 1.6;
    const y = target.y + bob;
    ctx.save();
    ctx.shadowColor = "rgba(19, 31, 65, 0.25)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = target.color;
    ctx.beginPath();
    ctx.arc(target.x, y, target.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#2f5660";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 249, 239, 0.7)";
    ctx.beginPath();
    ctx.arc(target.x - target.radius * 0.36, y - target.radius * 0.34, target.radius * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff9ef";
    ctx.beginPath();
    ctx.arc(target.x - 8, y - 2, 6.5, 0, Math.PI * 2);
    ctx.arc(target.x + 8, y - 2, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#18234c";
    ctx.beginPath();
    ctx.arc(target.x - 7, y - 1, 3, 0, Math.PI * 2);
    ctx.arc(target.x + 7, y - 1, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#385763";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(target.x, y + 7, 8, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.fillStyle = target.accent;
    if (target.variant === "cap") {
      ctx.beginPath();
      ctx.arc(target.x, y - target.radius + 2, 12, Math.PI, 0);
      ctx.lineTo(target.x + 12, y - target.radius + 3);
      ctx.lineTo(target.x - 12, y - target.radius + 3);
      ctx.closePath();
      ctx.fill();
    } else if (target.variant === "band") {
      ctx.fillRect(target.x - target.radius, y + 6, target.radius * 2, 7);
    } else {
      ctx.save();
      ctx.translate(target.x + 15, y - 17);
      ctx.rotate(0.5);
      ctx.beginPath();
      ctx.moveTo(0, -7); ctx.lineTo(3, -2); ctx.lineTo(9, -2); ctx.lineTo(4, 2);
      ctx.lineTo(6, 8); ctx.lineTo(0, 4); ctx.lineTo(-6, 8); ctx.lineTo(-4, 2);
      ctx.lineTo(-9, -2); ctx.lineTo(-3, -2); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawBird(ctx, state, time) {
    const bird = state.bird;
    if (!bird) return;
    const { x, y } = bird.position;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bird.rotation);
    if (state.phase === "ready" || state.phase === "aiming") {
      ctx.shadowColor = "rgba(255, 200, 87, 0.72)";
      ctx.shadowBlur = 25 + Math.sin(time * 4) * 4;
    }
    ctx.fillStyle = "#ee6d52";
    ctx.beginPath();
    ctx.moveTo(-19, 8); ctx.lineTo(-36, 2); ctx.lineTo(-25, -6); ctx.lineTo(-37, -15);
    ctx.lineTo(-14, -12); ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, bird.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#8f4344";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#ffc857";
    ctx.beginPath();
    ctx.moveTo(17, -2); ctx.lineTo(38, 4); ctx.lineTo(17, 10); ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#9b5244";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff9ef";
    ctx.beginPath();
    ctx.arc(-8, -7, 8, 0, Math.PI * 2);
    ctx.arc(9, -7, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#18234c";
    ctx.beginPath();
    ctx.arc(-5, -6, 3.4, 0, Math.PI * 2);
    ctx.arc(12, -6, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7f3b42";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-17, -18); ctx.lineTo(-3, -14);
    ctx.moveTo(3, -14); ctx.lineTo(18, -19);
    ctx.stroke();
    ctx.fillStyle = "#f7c24f";
    ctx.beginPath();
    ctx.arc(-11, 15, 5, 0, Math.PI * 2);
    ctx.arc(11, 15, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles(ctx, state) {
    for (const particle of state.particles) {
      ctx.save();
      ctx.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.fillStyle = particle.color;
      if (particle.star) {
        ctx.beginPath();
        ctx.moveTo(0, -particle.size * 1.8);
        ctx.lineTo(particle.size * 0.65, -particle.size * 0.55);
        ctx.lineTo(particle.size * 1.8, 0);
        ctx.lineTo(particle.size * 0.55, particle.size * 0.65);
        ctx.lineTo(0, particle.size * 1.8);
        ctx.lineTo(-particle.size * 0.55, particle.size * 0.65);
        ctx.lineTo(-particle.size * 1.8, 0);
        ctx.lineTo(-particle.size * 0.65, -particle.size * 0.55);
        ctx.closePath();
        ctx.fill();
      } else {
        roundedRect(ctx, -particle.size / 2, -particle.size / 2, particle.size, particle.size * 1.5, 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function drawFloaters(ctx, state) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = "900 18px Trebuchet MS, sans-serif";
    for (const floater of state.floaters) {
      ctx.globalAlpha = clamp(floater.life / floater.maxLife, 0, 1);
      ctx.fillStyle = "rgba(24, 35, 76, 0.4)";
      ctx.fillText(floater.text, floater.x + 2, floater.y + 3);
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, floater.x, floater.y);
    }
    ctx.restore();
  }

  function render(ctx, state, time) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.save();
    const shake = state.reducedMotion ? 0 : state.camera.shake;
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    drawBackground(ctx, state, time);
    drawSling(ctx, state);
    state.blocks.forEach((block) => drawBlock(ctx, block));
    state.targets.forEach((target) => drawTarget(ctx, target, time));
    drawTrajectory(ctx, state);
    drawBird(ctx, state, time);
    drawParticles(ctx, state);
    drawFloaters(ctx, state);
    ctx.restore();
  }

  function createAudio(windowObject, getState) {
    let audioContext = null;
    const frequencies = { launch: 220, target: 640, block: 350, ground: 120, win: 880, lose: 105, ui: 440 };

    function play(kind) {
      const state = getState();
      if (!state.soundEnabled) return;
      const AudioContext = windowObject && (windowObject.AudioContext || windowObject.webkitAudioContext);
      if (!AudioContext) return;
      try {
        audioContext = audioContext || new AudioContext();
        if (audioContext.state === "suspended") {
          const resume = audioContext.resume();
          if (resume && typeof resume.catch === "function") resume.catch(() => {});
        }
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        const start = audioContext.currentTime;
        const duration = kind === "win" ? 0.28 : kind === "lose" ? 0.36 : 0.12;
        oscillator.type = kind === "block" ? "square" : "sine";
        oscillator.frequency.setValueAtTime(frequencies[kind] || frequencies.ui, start);
        oscillator.frequency.exponentialRampToValueAtTime((frequencies[kind] || frequencies.ui) * 1.35, start + duration);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(kind === "win" ? 0.11 : 0.06, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain);
        gain.connect(audioContext.destination);
        oscillator.start(start);
        oscillator.stop(start + duration + 0.02);
      } catch (error) {
        audioContext = null;
      }
    }

    return { play };
  }

  function mount(documentObject) {
    const canvas = documentObject.getElementById("game");
    if (!canvas || canvas.dataset.mounted === "true") return null;
    const context = canvas.getContext("2d");
    if (!context) return null;
    canvas.dataset.mounted = "true";

    const windowObject = documentObject.defaultView || {};
    const state = createState();
    state.reducedMotion = Boolean(windowObject.matchMedia && windowObject.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const dom = {
      levelLabel: documentObject.getElementById("level-label"),
      sectionKicker: documentObject.getElementById("section-kicker"),
      levelSubtitle: documentObject.getElementById("level-subtitle"),
      targetLeft: documentObject.getElementById("target-left"),
      score: documentObject.getElementById("score"),
      scoreNote: documentObject.getElementById("score-note"),
      shotsLeft: documentObject.getElementById("shots-left"),
      shotPips: documentObject.getElementById("shot-pips"),
      phaseLabel: documentObject.getElementById("phase-label"),
      statusText: documentObject.getElementById("status-text"),
      canvasHint: documentObject.getElementById("canvas-hint"),
      overlay: documentObject.getElementById("game-overlay"),
      overlayKicker: documentObject.getElementById("overlay-kicker"),
      overlayTitle: documentObject.getElementById("overlay-title"),
      overlayCopy: documentObject.getElementById("overlay-copy"),
      nextLevel: documentObject.getElementById("next-level"),
      overlayReset: documentObject.getElementById("overlay-reset"),
      soundToggle: documentObject.getElementById("sound-toggle"),
    };
    const audio = createAudio(windowObject, () => state);
    const pixelRatio = Math.min(windowObject.devicePixelRatio || 1, 2);
    canvas.width = WIDTH * pixelRatio;
    canvas.height = HEIGHT * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    function updatePips() {
      if (dom.shotPips.children.length !== state.maxBirds) {
        dom.shotPips.innerHTML = "";
        for (let index = 0; index < state.maxBirds; index += 1) {
          const pip = documentObject.createElement("span");
          pip.className = "shot-pip";
          pip.setAttribute("aria-hidden", "true");
          dom.shotPips.appendChild(pip);
        }
      }
      [...dom.shotPips.children].forEach((pip, index) => pip.classList.toggle("is-used", index >= state.birdsLeft));
      dom.shotPips.setAttribute("aria-label", `${state.birdsLeft} of ${state.maxBirds} shots remaining`);
    }

    function updateOverlay() {
      const visible = state.phase === "won" || state.phase === "lost" || state.phase === "complete";
      dom.overlay.hidden = !visible;
      if (!visible) return;
      if (state.phase === "lost") {
        dom.overlayKicker.textContent = "Clouds 1 · Flock 0";
        dom.overlayTitle.textContent = "The clouds win this round.";
        dom.overlayCopy.textContent = "Try a lower pull for a flatter shot, or go high and let gravity do the mischief.";
        dom.nextLevel.hidden = true;
        dom.overlayReset.textContent = "Reload the sling";
      } else if (state.phase === "complete") {
        dom.overlayKicker.textContent = "All three islands cleared";
        dom.overlayTitle.textContent = "Cloudbreakers complete.";
        dom.overlayCopy.textContent = `Final score ${String(state.score).padStart(6, "0")}. The bandits are packing tiny suitcases.`;
        dom.nextLevel.hidden = true;
        dom.overlayReset.textContent = "Play from the top";
      } else {
        dom.overlayKicker.textContent = `Island ${state.levelIndex + 1} cleared`;
        dom.overlayTitle.textContent = "That was a proper bonk.";
        dom.overlayCopy.textContent = state.bonusAwarded && state.birdsLeft > 0
          ? `The bandits popped and you banked a ${state.birdsLeft * 250}-point bird bonus.`
          : "The bubble bandits have officially lost the plot.";
        dom.nextLevel.hidden = false;
        dom.overlayReset.textContent = "Replay island";
      }
    }

    function updateHud() {
      const level = getLevel(state);
      const remaining = state.targets.filter((target) => target.alive).length;
      const phaseCopy = {
        ready: "Ready to fling",
        aiming: "Angle locked",
        flying: "In the air",
        won: "Island cleared",
        lost: "Clouds win",
        complete: "Skyline saved",
      };
      dom.levelLabel.textContent = String(state.levelIndex + 1).padStart(2, "0");
      dom.sectionKicker.textContent = `Cloudbreakers / level ${state.levelIndex + 1}`;
      dom.levelSubtitle.textContent = level.subtitle;
      dom.targetLeft.textContent = String(remaining).padStart(2, "0");
      dom.score.textContent = String(state.score).padStart(6, "0");
      dom.shotsLeft.textContent = `${state.birdsLeft} ready`;
      dom.phaseLabel.textContent = phaseCopy[state.phase] || "Ready to fling";
      dom.statusText.textContent = state.message;
      dom.canvasHint.classList.toggle("is-hidden", state.phase !== "ready");
      canvas.dataset.state = state.phase;
      canvas.setAttribute("aria-label", `Flockshot level ${state.levelIndex + 1}, ${remaining} bandits remain, ${state.birdsLeft} shots available`);
      dom.scoreNote.textContent = state.levelScore > 0 ? "The sky is keeping score." : "Make the first bonk count.";
      updatePips();
      updateOverlay();
    }

    function consumeEvents() {
      const events = state.events.splice(0);
      events.forEach((event) => audio.play(event.kind));
    }

    function refresh() {
      updateHud();
      consumeEvents();
      render(context, state, state.elapsed);
    }

    function pointerToWorld(event) {
      const rectangle = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rectangle.left) / rectangle.width) * WIDTH,
        y: ((event.clientY - rectangle.top) / rectangle.height) * HEIGHT,
      };
    }

    let pointer = null;

    function onPointerDown(event) {
      if (state.phase !== "ready" && state.phase !== "aiming") return;
      const point = pointerToWorld(event);
      pointer = {
        id: event.pointerId,
        start: point,
        nearSling: distance(point, state.sling.anchor) < 175,
      };
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* capture is optional */ }
      try { canvas.focus({ preventScroll: true }); } catch (error) { canvas.focus(); }
      if (pointer.nearSling) setAim(state, point);
      event.preventDefault();
      refresh();
    }

    function onPointerMove(event) {
      if (!pointer || pointer.id !== event.pointerId || !pointer.nearSling) return;
      setAim(state, pointerToWorld(event));
      event.preventDefault();
      refresh();
    }

    function onPointerUp(event) {
      if (!pointer || pointer.id !== event.pointerId) return;
      const point = pointerToWorld(event);
      const startedNearSling = pointer.nearSling;
      pointer = null;
      try { canvas.releasePointerCapture(event.pointerId); } catch (error) { /* capture is optional */ }
      if (startedNearSling) {
        if (distance(point, state.sling.anchor) > 8) launch(state, point);
        else cancelAim(state);
      } else {
        launchToward(state, point);
      }
      event.preventDefault();
      refresh();
    }

    function onKeyDown(event) {
      const key = event.key.toLowerCase();
      const arrowDeltas = {
        arrowleft: { x: -13, y: 0 },
        arrowright: { x: 13, y: 0 },
        arrowup: { x: 0, y: -13 },
        arrowdown: { x: 0, y: 13 },
      };
      if (arrowDeltas[key]) {
        aimWithKeyboard(state, arrowDeltas[key]);
        event.preventDefault();
        refresh();
      } else if (event.code === "Space") {
        launch(state, state.aim || { x: state.sling.anchor.x - 82, y: state.sling.anchor.y + 36 });
        event.preventDefault();
        refresh();
      } else if (key === "r") {
        reset(state);
        event.preventDefault();
        refresh();
      } else if (key === "n" && (state.phase === "won" || state.phase === "complete")) {
        nextLevel(state);
        event.preventDefault();
        refresh();
      }
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    documentObject.addEventListener("keydown", (event) => {
      if (event.target === canvas || event.target === documentObject.body) onKeyDown(event);
    });
    documentObject.getElementById("reset-game").addEventListener("click", () => {
      restartRun(state);
      audio.play("ui");
      refresh();
    });
    dom.overlayReset.addEventListener("click", () => {
      if (state.phase === "complete") restartRun(state);
      else reset(state);
      audio.play("ui");
      refresh();
    });
    dom.nextLevel.addEventListener("click", () => {
      nextLevel(state);
      audio.play("ui");
      refresh();
    });
    dom.soundToggle.addEventListener("click", () => {
      state.soundEnabled = !state.soundEnabled;
      dom.soundToggle.setAttribute("aria-pressed", String(state.soundEnabled));
      dom.soundToggle.setAttribute("aria-label", state.soundEnabled ? "Turn sound off" : "Turn sound on");
      dom.soundToggle.textContent = state.soundEnabled ? "♫" : "×";
      if (state.soundEnabled) audio.play("ui");
    });

    let lastTime = windowObject.performance && windowObject.performance.now ? windowObject.performance.now() : Date.now();
    const requestFrame = windowObject.requestAnimationFrame
      ? windowObject.requestAnimationFrame.bind(windowObject)
      : (callback) => windowObject.setTimeout(() => callback(Date.now()), 16);

    function loop(now) {
      const delta = Math.min(Math.max((now - lastTime) / 1000, 0), 0.05);
      lastTime = now;
      step(state, delta);
      refresh();
      requestFrame(loop);
    }

    updateHud();
    render(context, state, 0);
    requestFrame(loop);
    return { state, canvas };
  }

  return {
    WIDTH,
    HEIGHT,
    LEVELS,
    createState,
    getLevel,
    getAimPoint,
    previewTrajectory,
    setAim,
    cancelAim,
    launch,
    launchToward,
    aimWithKeyboard,
    circleTouchesRect,
    step,
    resolveOutcome,
    reset,
    restartRun,
    nextLevel,
    mount,
  };
});
