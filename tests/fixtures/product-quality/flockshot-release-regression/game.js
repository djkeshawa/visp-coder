(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Flockshot = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const WIDTH = 960;
  const HEIGHT = 540;
  const GROUND_Y = 448;
  const ORIGIN = { x: 142, y: 386 };
  const DEFAULT_PULL = { x: 110, y: 418 };
  const MAX_PULL = 108;
  const BIRD_RADIUS = 22;
  const POWER = 7;
  const GRAVITY = 780;
  const TAU = Math.PI * 2;

  const LEVELS = [
    {
      name: "Sunset Switchbacks",
      breeze: "calm",
      wind: 0,
      shots: 4,
      blocks: [
        { x: 620, y: 368, w: 28, h: 80, material: "wood", hp: 2 },
        { x: 770, y: 368, w: 28, h: 80, material: "wood", hp: 2 },
        { x: 695, y: 326, w: 150, h: 24, material: "wood", hp: 1 },
        { x: 693, y: 270, w: 28, h: 70, material: "wood", hp: 1 },
        { x: 770, y: 270, w: 28, h: 70, material: "wood", hp: 1 }
      ],
      targets: [
        { x: 663, y: 412, r: 25 },
        { x: 749, y: 412, r: 25 }
      ]
    },
    {
      name: "The Tilted Tangle",
      breeze: "left drift",
      wind: -26,
      shots: 4,
      blocks: [
        { x: 605, y: 382, w: 27, h: 66, material: "wood", hp: 2 },
        { x: 694, y: 382, w: 27, h: 66, material: "wood", hp: 2 },
        { x: 783, y: 382, w: 27, h: 66, material: "wood", hp: 2 },
        { x: 649, y: 338, w: 150, h: 24, material: "wood", hp: 1 },
        { x: 688, y: 278, w: 26, h: 65, material: "glass", hp: 1 },
        { x: 760, y: 278, w: 26, h: 65, material: "glass", hp: 1 },
        { x: 725, y: 220, w: 130, h: 22, material: "wood", hp: 1 }
      ],
      targets: [
        { x: 620, y: 411, r: 24 },
        { x: 707, y: 310, r: 23 },
        { x: 796, y: 411, r: 24 }
      ]
    },
    {
      name: "Moonrise Mayhem",
      breeze: "high crosswind",
      wind: 38,
      shots: 5,
      blocks: [
        { x: 590, y: 384, w: 25, h: 64, material: "glass", hp: 1 },
        { x: 675, y: 384, w: 25, h: 64, material: "wood", hp: 2 },
        { x: 760, y: 384, w: 25, h: 64, material: "glass", hp: 1 },
        { x: 845, y: 384, w: 25, h: 64, material: "wood", hp: 2 },
        { x: 613, y: 340, w: 235, h: 23, material: "wood", hp: 1 },
        { x: 640, y: 280, w: 26, h: 66, material: "glass", hp: 1 },
        { x: 798, y: 280, w: 26, h: 66, material: "glass", hp: 1 },
        { x: 677, y: 224, w: 112, h: 22, material: "wood", hp: 1 },
        { x: 712, y: 165, w: 25, h: 70, material: "wood", hp: 1 }
      ],
      targets: [
        { x: 603, y: 412, r: 23 },
        { x: 716, y: 315, r: 23 },
        { x: 812, y: 315, r: 23 },
        { x: 857, y: 412, r: 23 }
      ]
    }
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function lengthOf(x, y) {
    return Math.sqrt(x * x + y * y);
  }

  function circleRectCollision(circle, rect) {
    const closestX = clamp(circle.x, rect.x, rect.x + rect.w);
    const closestY = clamp(circle.y, rect.y, rect.y + rect.h);
    let normalX = circle.x - closestX;
    let normalY = circle.y - closestY;
    const distance = lengthOf(normalX, normalY);

    if (distance > circle.r) return null;

    if (distance === 0) {
      const left = Math.abs(circle.x - rect.x);
      const right = Math.abs(rect.x + rect.w - circle.x);
      const top = Math.abs(circle.y - rect.y);
      const bottom = Math.abs(rect.y + rect.h - circle.y);
      const smallest = Math.min(left, right, top, bottom);
      if (smallest === left) {
        normalX = -1;
        normalY = 0;
      } else if (smallest === right) {
        normalX = 1;
        normalY = 0;
      } else if (smallest === top) {
        normalX = 0;
        normalY = -1;
      } else {
        normalX = 0;
        normalY = 1;
      }
      return { normal: { x: normalX, y: normalY }, depth: circle.r + smallest };
    }

    return {
      normal: { x: normalX / distance, y: normalY / distance },
      depth: circle.r - distance
    };
  }

  class GameEngine {
    constructor(options) {
      const settings = options || {};
      this.levels = settings.levels && settings.levels.length ? settings.levels : LEVELS;
      this.levelIndex = 0;
      this.score = 0;
      this.clearedLevels = new Set();
      this.events = [];
      this.resetLevel(0);
    }

    resetLevel(index) {
      const safeIndex = clamp(Number.isInteger(index) ? index : this.levelIndex, 0, this.levels.length - 1);
      const level = clone(this.levels[safeIndex]);
      this.levelIndex = safeIndex;
      this.level = level;
      this.wind = Number(level.wind) || 0;
      this.blocks = level.blocks.map((block, id) => ({
        ...block,
        id,
        maxHp: block.hp,
        broken: false
      }));
      this.targets = level.targets.map((target, id) => ({
        ...target,
        id,
        alive: true
      }));
      this.shotsLeft = level.shots;
      this.state = "ready";
      this.flightTime = 0;
      this.settleTime = 0;
      this.aim = { ...DEFAULT_PULL };
      this.bird = this.makeReadyBird();
      this.message = "Ember is ready. Pull back and let fly.";
      this.events = [];
      return this.snapshot();
    }

    makeReadyBird() {
      return {
        x: this.aim.x,
        y: this.aim.y,
        vx: 0,
        vy: 0,
        r: BIRD_RADIUS,
        rotation: 0,
        trail: []
      };
    }

    setAim(x, y) {
      if (this.state !== "ready") return false;
      let dx = Number(x) - ORIGIN.x;
      let dy = Number(y) - ORIGIN.y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
      const distance = lengthOf(dx, dy);
      if (distance > MAX_PULL) {
        dx = (dx / distance) * MAX_PULL;
        dy = (dy / distance) * MAX_PULL;
      }
      this.aim = { x: ORIGIN.x + dx, y: ORIGIN.y + dy };
      this.bird = this.makeReadyBird();
      return true;
    }

    adjustAim(direction, amount) {
      const nudge = Number(amount) || 8;
      const next = { ...this.aim };
      if (direction === "left") next.x -= nudge;
      if (direction === "right") next.x += nudge;
      if (direction === "up") next.y += nudge;
      if (direction === "down") next.y -= nudge;
      return this.setAim(next.x, next.y);
    }

    getLaunchVelocity() {
      let dx = ORIGIN.x - this.aim.x;
      let dy = ORIGIN.y - this.aim.y;
      if (lengthOf(dx, dy) < 42) {
        dx = ORIGIN.x - DEFAULT_PULL.x;
        dy = ORIGIN.y - DEFAULT_PULL.y;
      }
      return {
        x: dx * POWER + this.wind * 0.08,
        y: dy * POWER
      };
    }

    launch() {
      if (this.state !== "ready") return false;
      const velocity = this.getLaunchVelocity();
      this.shotsLeft = Math.max(0, this.shotsLeft - 1);
      this.bird = {
        x: this.aim.x,
        y: this.aim.y,
        vx: velocity.x,
        vy: velocity.y,
        r: BIRD_RADIUS,
        rotation: 0,
        trail: []
      };
      this.flightTime = 0;
      this.settleTime = 0;
      this.state = "flying";
      this.message = "Ember is airborne. Watch the ricochet.";
      this.events.push({ type: "launch", x: this.bird.x, y: this.bird.y });
      return true;
    }

    launchAt(x, y) {
      if (this.state !== "ready") return false;
      const dx = Number(x) - ORIGIN.x;
      const dy = Number(y) - ORIGIN.y;
      const distance = lengthOf(dx, dy);
      if (!Number.isFinite(distance) || distance < 1) {
        this.setAim(DEFAULT_PULL.x, DEFAULT_PULL.y);
      } else {
        const pull = clamp(distance * 0.22, 58, MAX_PULL);
        this.setAim(
          ORIGIN.x - (dx / distance) * pull,
          ORIGIN.y - (dy / distance) * pull
        );
      }
      return this.launch();
    }

    resetCurrent() {
      return this.resetLevel(this.levelIndex);
    }

    nextLevel() {
      if (this.state !== "won" || this.levelIndex >= this.levels.length - 1) return false;
      this.clearedLevels.add(this.levelIndex);
      return Boolean(this.resetLevel(this.levelIndex + 1));
    }

    getRemainingTargets() {
      return this.targets.filter((target) => target.alive).length;
    }

    getPreview() {
      if (this.state !== "ready") return [];
      const velocity = this.getLaunchVelocity();
      const points = [];
      let x = this.aim.x;
      let y = this.aim.y;
      let vx = velocity.x;
      let vy = velocity.y;
      for (let i = 0; i < 17; i += 1) {
        points.push({ x, y });
        vy += GRAVITY * 0.1;
        vx += this.wind * 0.1;
        x += vx * 0.1;
        y += vy * 0.1;
        if (y > GROUND_Y || x > WIDTH + 50) break;
      }
      return points;
    }

    step(deltaSeconds) {
      if (this.state !== "flying") return this.snapshot();
      const dt = clamp(Number(deltaSeconds) || 0, 0, 0.05);
      this.flightTime += dt;
      const bird = this.bird;
      const speedBefore = lengthOf(bird.vx, bird.vy);

      bird.trail.unshift({ x: bird.x, y: bird.y });
      if (bird.trail.length > 16) bird.trail.pop();
      bird.vy += GRAVITY * dt;
      bird.vx += this.wind * dt;
      bird.x += bird.vx * dt;
      bird.y += bird.vy * dt;
      bird.rotation += (bird.vx * dt) / Math.max(1, bird.r);

      this.resolveCollisions(speedBefore);
      if (this.getRemainingTargets() === 0) {
        this.finishWin();
        return this.snapshot();
      }

      if (bird.y + bird.r >= GROUND_Y) {
        bird.y = GROUND_Y - bird.r;
        if (Math.abs(bird.vy) > 145) {
          bird.vy = -Math.abs(bird.vy) * 0.38;
          bird.vx *= 0.82;
          this.events.push({ type: "bounce", x: bird.x, y: bird.y });
        } else {
          bird.vy = 0;
          bird.vx *= 0.9;
          this.settleTime += dt;
        }
      } else {
        this.settleTime = 0;
      }

      const outOfBounds = bird.x < -90 || bird.x > WIDTH + 90 || bird.y > HEIGHT + 80;
      if (outOfBounds || this.flightTime > 9 || this.settleTime > 0.42) {
        this.finishFlight(outOfBounds ? "out" : "settled");
      }
      return this.snapshot();
    }

    resolveCollisions(speedBefore) {
      const bird = this.bird;
      const speed = Math.max(speedBefore, lengthOf(bird.vx, bird.vy));
      // A clean line can bonk a muncher through a gap before the nearby
      // structure absorbs the impact, which keeps direct shots rewarding.
      for (const target of this.targets) {
        if (!target.alive) continue;
        const dx = bird.x - target.x;
        const dy = bird.y - target.y;
        if (lengthOf(dx, dy) > bird.r + target.r || speed < 45) continue;
        target.alive = false;
        this.score += 150;
        this.message = "Cloud muncher bonked! +150";
        bird.vx *= 0.52;
        bird.vy *= 0.52;
        this.events.push({ type: "target-hit", x: target.x, y: target.y });
      }

      for (const block of this.blocks) {
        if (block.broken) continue;
        const hit = circleRectCollision(bird, block);
        if (!hit || speed < 70) continue;
        bird.x += hit.normal.x * (hit.depth + 1);
        bird.y += hit.normal.y * (hit.depth + 1);
        const damage = speed > 390 ? 2 : 1;
        block.hp -= damage;
        if (block.hp <= 0) {
          block.broken = true;
          this.score += block.material === "glass" ? 75 : 60;
          this.events.push({
            type: "block-break",
            x: bird.x,
            y: bird.y,
            material: block.material
          });
        } else {
          this.score += 10;
          this.events.push({ type: "block-hit", x: bird.x, y: bird.y });
        }
        if (block.broken) {
          bird.vx *= 0.92;
          bird.vy *= 0.92;
        } else if (Math.abs(hit.normal.x) > Math.abs(hit.normal.y)) {
          bird.vx *= -0.46;
          bird.vy *= 0.86;
        } else {
          bird.vy *= -0.46;
          bird.vx *= 0.86;
        }
      }
    }

    finishWin() {
      if (this.state === "won") return;
      this.state = "won";
      this.bird.vx = 0;
      this.bird.vy = 0;
      this.message = this.levelIndex === this.levels.length - 1
        ? "The whole sky is yours. Legendary."
        : "Island cleared! Your next flight is ready.";
      this.events.push({ type: "win" });
    }

    finishFlight(reason) {
      if (this.state !== "flying") return;
      this.state = "settled";
      this.events.push({ type: "settled", reason });
      if (this.getRemainingTargets() === 0) {
        this.finishWin();
      } else if (this.shotsLeft > 0) {
        this.state = "ready";
        this.aim = { ...DEFAULT_PULL };
        this.bird = this.makeReadyBird();
        this.message = "Next Ember loaded. There is still mischief to make.";
        this.events.push({ type: "ready" });
      } else {
        this.state = "lost";
        this.message = "The clouds held their ground. Reset and try a new angle.";
        this.events.push({ type: "lose" });
      }
    }

    consumeEvents() {
      const events = this.events.slice();
      this.events.length = 0;
      return events;
    }

    snapshot() {
      return {
        state: this.state,
        levelIndex: this.levelIndex,
        score: this.score,
        shotsLeft: this.shotsLeft,
        remainingTargets: this.getRemainingTargets(),
        blocksStanding: this.blocks.filter((block) => !block.broken).length,
        message: this.message
      };
    }
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  function drawCloud(ctx, x, y, scale, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y + 10 * scale, 22 * scale, Math.PI, TAU);
    ctx.arc(x + 22 * scale, y, 27 * scale, Math.PI, TAU);
    ctx.arc(x + 53 * scale, y + 8 * scale, 20 * scale, Math.PI, TAU);
    ctx.lineTo(x + 73 * scale, y + 24 * scale);
    ctx.lineTo(x - 2 * scale, y + 24 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawSky(ctx, now) {
    const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    sky.addColorStop(0, "#29205b");
    sky.addColorStop(0.42, "#674074");
    sky.addColorStop(0.74, "#ed816a");
    sky.addColorStop(1, "#ffbe78");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    ctx.save();
    ctx.globalAlpha = 0.48;
    ctx.fillStyle = "#ffe4a1";
    ctx.beginPath();
    ctx.arc(790, 108, 54, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = "#fff7d7";
    ctx.beginPath();
    ctx.arc(790, 108, 76, 0, TAU);
    ctx.fill();
    ctx.restore();

    const stars = [
      [74, 64, 2], [138, 124, 1.5], [235, 48, 2], [320, 94, 1.5],
      [438, 42, 1.6], [552, 128, 2], [650, 63, 1.2], [894, 55, 2],
      [918, 158, 1.3], [482, 172, 1.1]
    ];
    ctx.fillStyle = "#fff1bd";
    stars.forEach(([x, y, radius], index) => {
      const pulse = 0.68 + Math.sin(now * 0.0015 + index) * 0.2;
      ctx.globalAlpha = pulse;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, TAU);
      ctx.fill();
    });
    ctx.globalAlpha = 1;

    drawCloud(ctx, 56, 188, 0.8, "#f7d6d0", 0.18);
    drawCloud(ctx, 398, 126, 0.56, "#fff0d2", 0.2);
    drawCloud(ctx, 818, 234, 0.92, "#ffe9d4", 0.16);
    drawCloud(ctx, 278, 278, 0.42, "#fff0d2", 0.16);

    ctx.fillStyle = "#463469";
    ctx.beginPath();
    ctx.moveTo(0, 362);
    ctx.bezierCurveTo(130, 322, 184, 362, 293, 336);
    ctx.bezierCurveTo(422, 303, 515, 360, 634, 332);
    ctx.bezierCurveTo(765, 300, 838, 338, WIDTH, 302);
    ctx.lineTo(WIDTH, GROUND_Y);
    ctx.lineTo(0, GROUND_Y);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#332750";
    ctx.beginPath();
    ctx.moveTo(0, 404);
    ctx.bezierCurveTo(170, 368, 236, 409, 383, 384);
    ctx.bezierCurveTo(542, 356, 649, 407, 780, 374);
    ctx.bezierCurveTo(864, 354, 914, 374, WIDTH, 354);
    ctx.lineTo(WIDTH, GROUND_Y);
    ctx.lineTo(0, GROUND_Y);
    ctx.closePath();
    ctx.fill();
  }

  function drawIsland(ctx) {
    ctx.fillStyle = "#8bcf9d";
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(WIDTH, GROUND_Y);
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#5eae83";
    ctx.beginPath();
    ctx.moveTo(0, 459);
    ctx.bezierCurveTo(128, 441, 244, 474, 362, 455);
    ctx.bezierCurveTo(510, 432, 638, 470, 774, 448);
    ctx.bezierCurveTo(852, 436, 903, 448, WIDTH, 439);
    ctx.lineTo(WIDTH, HEIGHT);
    ctx.lineTo(0, HEIGHT);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#3f816c";
    ctx.globalAlpha = 0.55;
    for (let x = 18; x < WIDTH; x += 42) {
      ctx.fillRect(x, 470 + (x % 17), 3, 18);
      ctx.fillRect(x + 8, 478 + (x % 13), 2, 12);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#b7e2a0";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.bezierCurveTo(144, 432, 258, 466, 395, 444);
    ctx.bezierCurveTo(557, 421, 674, 461, 810, 438);
    ctx.bezierCurveTo(870, 428, 917, 440, WIDTH, 430);
    ctx.stroke();
  }

  function drawSling(ctx, engine) {
    const bird = engine.bird;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#30214b";
    ctx.lineWidth = 15;
    ctx.beginPath();
    ctx.moveTo(ORIGIN.x - 9, GROUND_Y - 7);
    ctx.lineTo(ORIGIN.x - 20, ORIGIN.y - 31);
    ctx.moveTo(ORIGIN.x + 10, GROUND_Y - 7);
    ctx.lineTo(ORIGIN.x + 22, ORIGIN.y - 35);
    ctx.stroke();
    ctx.strokeStyle = "#e8b26c";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(ORIGIN.x - 20, ORIGIN.y - 31);
    ctx.lineTo(bird.x, bird.y);
    ctx.moveTo(ORIGIN.x + 22, ORIGIN.y - 35);
    ctx.lineTo(bird.x, bird.y);
    ctx.stroke();
    ctx.fillStyle = "#ffcb6b";
    ctx.beginPath();
    ctx.ellipse(ORIGIN.x, GROUND_Y - 6, 34, 7, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawTrajectory(ctx, engine) {
    if (engine.state !== "ready") return;
    const points = engine.getPreview();
    ctx.save();
    points.forEach((point, index) => {
      if (index % 2 !== 0) return;
      const alpha = 0.32 - index * 0.012;
      ctx.globalAlpha = Math.max(0.06, alpha);
      ctx.fillStyle = "#fff2b1";
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(2, 5 - index * 0.17), 0, TAU);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawBlock(ctx, block) {
    if (block.broken) return;
    const glass = block.material === "glass";
    ctx.save();
    ctx.shadowColor = "rgba(32, 18, 55, .22)";
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 5;
    roundedRect(ctx, block.x, block.y, block.w, block.h, 7);
    ctx.fillStyle = glass ? "rgba(143, 225, 193, .78)" : "#d9955f";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = glass ? "#d6ffe4" : "#7e4c4d";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.globalAlpha = glass ? 0.45 : 0.35;
    ctx.strokeStyle = glass ? "#fff6d2" : "#ffe2a6";
    ctx.lineWidth = 2;
    for (let x = block.x + 13; x < block.x + block.w; x += 25) {
      ctx.beginPath();
      ctx.moveTo(x, block.y + 5);
      ctx.lineTo(x - 5, block.y + block.h - 5);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!glass && block.hp < block.maxHp) {
      ctx.strokeStyle = "#75414a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(block.x + block.w * 0.48, block.y + 9);
      ctx.lineTo(block.x + block.w * 0.35, block.y + block.h * 0.45);
      ctx.lineTo(block.x + block.w * 0.6, block.y + block.h * 0.65);
      ctx.lineTo(block.x + block.w * 0.48, block.y + block.h - 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTarget(ctx, target) {
    if (!target.alive) return;
    const r = target.r;
    ctx.save();
    ctx.translate(target.x, target.y);
    ctx.shadowColor = "rgba(25, 35, 54, .25)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 5;
    ctx.fillStyle = "#65c99d";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#8fe1c1";
    ctx.beginPath();
    ctx.arc(-r * 0.62, -r * 0.72, r * 0.42, 0, TAU);
    ctx.arc(r * 0.62, -r * 0.72, r * 0.42, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#2d4560";
    ctx.beginPath();
    ctx.arc(-r * 0.34, -r * 0.08, r * 0.13, 0, TAU);
    ctx.arc(r * 0.34, -r * 0.08, r * 0.13, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "#2d4560";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, r * 0.15, r * 0.42, 0.14, Math.PI - 0.14);
    ctx.stroke();
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.moveTo(-r * 0.28, r * 0.78);
    ctx.lineTo(0, r * 1.05);
    ctx.lineTo(r * 0.28, r * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBird(ctx, bird) {
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation);
    ctx.fillStyle = "#d94c4c";
    ctx.beginPath();
    ctx.moveTo(-bird.r * 0.76, -bird.r * 0.1);
    ctx.lineTo(-bird.r * 1.45, -bird.r * 0.56);
    ctx.lineTo(-bird.r * 1.14, 0);
    ctx.lineTo(-bird.r * 1.48, bird.r * 0.4);
    ctx.lineTo(-bird.r * 0.58, bird.r * 0.34);
    ctx.closePath();
    ctx.fill();

    const body = ctx.createRadialGradient(-7, -10, 2, 4, 5, bird.r * 1.3);
    body.addColorStop(0, "#ff8961");
    body.addColorStop(0.72, "#f25d4e");
    body.addColorStop(1, "#cf3f4c");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, bird.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "#712e49";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = "#ffcb6b";
    ctx.beginPath();
    ctx.moveTo(-8, -17);
    ctx.lineTo(-4, -32);
    ctx.lineTo(3, -20);
    ctx.lineTo(10, -34);
    ctx.lineTo(14, -14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffd98a";
    ctx.beginPath();
    ctx.moveTo(11, -2);
    ctx.lineTo(35, 5);
    ctx.lineTo(11, 13);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#9a4a4a";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "#fff9df";
    ctx.beginPath();
    ctx.arc(8, -8, 8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#29204c";
    ctx.beginPath();
    ctx.arc(10, -8, 3.3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "#552a46";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(1, -18);
    ctx.lineTo(17, -14);
    ctx.stroke();
    ctx.restore();
  }

  function drawParticles(ctx, particles) {
    particles.forEach((particle) => {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      if (particle.shape === "spark") {
        ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  function drawOverlay(ctx, engine) {
    if (engine.state !== "won" && engine.state !== "lost") return;
    ctx.save();
    ctx.fillStyle = "rgba(23, 19, 50, .34)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const panelWidth = 390;
    const panelHeight = 166;
    const panelX = (WIDTH - panelWidth) / 2;
    const panelY = 178;
    roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 18);
    ctx.fillStyle = "#fff8e9";
    ctx.fill();
    ctx.strokeStyle = engine.state === "won" ? "#ff765a" : "#6a4c93";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.fillStyle = "#dc4e49";
    ctx.font = "900 15px Trebuchet MS, sans-serif";
    ctx.fillText(engine.state === "won" ? "FLIGHT LOG UPDATED" : "WEATHER REPORT", WIDTH / 2, panelY + 32);
    ctx.fillStyle = "#171332";
    ctx.font = "900 31px Trebuchet MS, sans-serif";
    ctx.fillText(engine.state === "won" ? "Island cleared!" : "Not this time.", WIDTH / 2, panelY + 74);
    ctx.fillStyle = "#4b416b";
    ctx.font = "15px Trebuchet MS, sans-serif";
    ctx.fillText(
      engine.state === "won" ? "Hit the next-island button to keep the streak alive." : "Reset flight and try a lower, louder angle.",
      WIDTH / 2,
      panelY + 110
    );
    ctx.restore();
  }

  function drawScene(ctx, engine, particles, now, reducedMotion, shake) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.save();
    if (!reducedMotion && shake > 0.3) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    drawSky(ctx, now);
    drawIsland(ctx);
    drawTrajectory(ctx, engine);
    drawSling(ctx, engine);
    engine.blocks.forEach((block) => drawBlock(ctx, block));
    engine.targets.forEach((target) => drawTarget(ctx, target));
    drawBird(ctx, engine.bird);
    drawParticles(ctx, particles);
    drawOverlay(ctx, engine);
    ctx.restore();
  }

  function createBrowserGame(doc) {
    if (!doc) return null;
    const canvas = doc.getElementById("game");
    if (!canvas || !canvas.getContext) return null;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    const win = doc.defaultView || (typeof window !== "undefined" ? window : globalThis);
    const scoreElement = doc.getElementById("score");
    const shotsElement = doc.getElementById("shots");
    const targetsElement = doc.getElementById("targets");
    const levelElement = doc.getElementById("level-label");
    const levelNameElement = doc.getElementById("level-name");
    const windElement = doc.getElementById("wind-label");
    const statusElement = doc.getElementById("status-line");
    const resetButton = doc.getElementById("reset-game");
    const nextButton = doc.getElementById("next-level");
    const soundButton = doc.getElementById("sound-toggle");
    const dots = Array.from(doc.querySelectorAll("[data-level-dot]"));
    const engine = new GameEngine();
    const particles = [];
    let dragging = false;
    let soundEnabled = true;
    let audioContext = null;
    let shake = 0;
    const reducedMotion = Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);

    function ensureAudio() {
      if (!soundEnabled) return null;
      try {
        const AudioCtor = win.AudioContext || win.webkitAudioContext;
        if (!AudioCtor) return null;
        if (!audioContext) audioContext = new AudioCtor();
        if (audioContext.state === "suspended") audioContext.resume();
        return audioContext;
      } catch (error) {
        return null;
      }
    }

    function tone(kind) {
      const audio = ensureAudio();
      if (!audio) return;
      try {
        const settings = {
          grab: [230, 0.07, "sine", 0.035],
          launch: [310, 0.14, "triangle", 0.045],
          hit: [180, 0.08, "square", 0.03],
          break: [120, 0.16, "sawtooth", 0.035],
          win: [560, 0.28, "triangle", 0.05],
          lose: [110, 0.24, "sine", 0.04]
        }[kind] || [260, 0.1, "sine", 0.03];
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = settings[2];
        oscillator.frequency.setValueAtTime(settings[0], audio.currentTime);
        oscillator.frequency.exponentialRampToValueAtTime(settings[0] * (kind === "win" ? 1.6 : 0.72), audio.currentTime + settings[1]);
        gain.gain.setValueAtTime(settings[3], audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + settings[1]);
        oscillator.connect(gain);
        gain.connect(audio.destination);
        oscillator.start();
        oscillator.stop(audio.currentTime + settings[1]);
      } catch (error) {
        // Audio is a bonus; a browser without Web Audio should still play.
      }
    }

    function pointFromEvent(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * WIDTH,
        y: ((event.clientY - rect.top) / rect.height) * HEIGHT
      };
    }

    function burst(x, y, color, count) {
      const amount = reducedMotion ? Math.ceil(count * 0.35) : count;
      for (let i = 0; i < amount; i += 1) {
        const angle = (Math.PI * 2 * i) / amount + Math.random() * 0.5;
        const speed = 55 + Math.random() * 170;
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 45,
          size: 2 + Math.random() * 4,
          color,
          life: 0.45 + Math.random() * 0.38,
          maxLife: 0.82,
          rotation: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 8,
          shape: i % 3 === 0 ? "spark" : "dot"
        });
      }
    }

    function clearParticles() {
      particles.length = 0;
    }

    function handleEvents() {
      engine.consumeEvents().forEach((event) => {
        if (event.type === "launch") {
          tone("launch");
          burst(event.x, event.y, "#ffd166", 8);
        }
        if (event.type === "target-hit") {
          tone("hit");
          burst(event.x, event.y, "#8fe1c1", 28);
          shake = reducedMotion ? 0 : 9;
        }
        if (event.type === "block-hit") {
          tone("hit");
          burst(event.x, event.y, "#ffe1a3", 9);
          shake = reducedMotion ? 0 : 4;
        }
        if (event.type === "block-break") {
          tone("break");
          burst(event.x, event.y, event.material === "glass" ? "#d6ffe4" : "#e6a168", 24);
          shake = reducedMotion ? 0 : 7;
        }
        if (event.type === "bounce") burst(event.x, event.y, "#fff0be", 6);
        if (event.type === "win") {
          tone("win");
          burst(WIDTH / 2, 220, "#ffd166", 42);
          shake = reducedMotion ? 0 : 4;
        }
        if (event.type === "lose") tone("lose");
      });
    }

    function updateParticles(dt) {
      for (let i = particles.length - 1; i >= 0; i -= 1) {
        const particle = particles[i];
        particle.life -= dt;
        particle.vy += 330 * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        particle.rotation += particle.spin * dt;
        if (particle.life <= 0) particles.splice(i, 1);
      }
      shake *= reducedMotion ? 0 : 0.82;
    }

    function syncHud() {
      const snapshot = engine.snapshot();
      canvas.dataset.state = snapshot.state;
      canvas.setAttribute("aria-label", "Flockshot playfield. " + snapshot.message);
      if (scoreElement) scoreElement.textContent = String(snapshot.score).padStart(4, "0");
      if (shotsElement) shotsElement.textContent = String(snapshot.shotsLeft).padStart(2, "0");
      if (targetsElement) targetsElement.textContent = String(snapshot.remainingTargets).padStart(2, "0");
      if (levelElement) levelElement.textContent = "Island " + String(snapshot.levelIndex + 1).padStart(2, "0");
      if (levelNameElement) levelNameElement.textContent = engine.level.name;
      if (windElement) windElement.textContent = "↝ breeze · " + engine.level.breeze;
      if (statusElement) statusElement.textContent = snapshot.message;
      if (nextButton) {
        const canAdvance = snapshot.state === "won" && snapshot.levelIndex < engine.levels.length - 1;
        nextButton.disabled = !canAdvance;
        const nextLabel = (snapshot.levelIndex === engine.levels.length - 1 ? "Campaign complete" : "Next island") + " <span class=\"key\">ENTER</span>";
        if (nextButton.innerHTML !== nextLabel) nextButton.innerHTML = nextLabel;
      }
      dots.forEach((dot, index) => {
        dot.classList.toggle("current", index === snapshot.levelIndex);
        dot.classList.toggle("cleared", index < snapshot.levelIndex || (index === snapshot.levelIndex && snapshot.state === "won"));
      });
    }

    function render() {
      drawScene(ctx, engine, particles, Date.now(), reducedMotion, shake);
      syncHud();
    }

    function resetGame() {
      dragging = false;
      engine.resetCurrent();
      clearParticles();
      tone("grab");
      handleEvents();
      render();
      canvas.focus({ preventScroll: true });
    }

    function advanceLevel() {
      if (!engine.nextLevel()) return;
      dragging = false;
      clearParticles();
      tone("launch");
      handleEvents();
      render();
      canvas.focus({ preventScroll: true });
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      if (soundButton) {
        soundButton.setAttribute("aria-pressed", String(soundEnabled));
        soundButton.innerHTML = "Sound: " + (soundEnabled ? "on" : "off") + " <span class=\"key\">M</span>";
      }
      if (soundEnabled) tone("grab");
    }

    canvas.addEventListener("pointerdown", (event) => {
      if (engine.state !== "ready") return;
      ensureAudio();
      const point = pointFromEvent(event);
      const nearBird = lengthOf(point.x - engine.bird.x, point.y - engine.bird.y) < 42;
      if (nearBird) {
        dragging = true;
        engine.setAim(point.x, point.y);
        try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
        tone("grab");
      } else {
        engine.launchAt(point.x, point.y);
      }
      handleEvents();
      render();
    });

    canvas.addEventListener("pointermove", (event) => {
      if (!dragging || engine.state !== "ready") return;
      const point = pointFromEvent(event);
      engine.setAim(point.x, point.y);
      render();
    });

    function releasePointer(event) {
      if (!dragging) return;
      dragging = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch (error) {}
      engine.launch();
      handleEvents();
      render();
    }

    canvas.addEventListener("pointerup", releasePointer);
    canvas.addEventListener("pointercancel", releasePointer);
    if (resetButton) resetButton.addEventListener("click", resetGame);
    if (nextButton) nextButton.addEventListener("click", advanceLevel);
    if (soundButton) soundButton.addEventListener("click", toggleSound);

    doc.addEventListener("keydown", (event) => {
      const key = event.key;
      if (key === "r" || key === "R") {
        event.preventDefault();
        resetGame();
        return;
      }
      if (key === "m" || key === "M") {
        event.preventDefault();
        toggleSound();
        return;
      }
      if (key === "Enter" && engine.state === "won") {
        event.preventDefault();
        advanceLevel();
        return;
      }
      if (engine.state !== "ready") return;
      const directions = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down"
      };
      if (directions[key]) {
        event.preventDefault();
        engine.adjustAim(directions[key], 9);
        render();
      } else if (key === " " || key === "Spacebar") {
        event.preventDefault();
        ensureAudio();
        engine.launch();
        handleEvents();
        render();
      }
    });

    let previous = Date.now();
    function frame(now) {
      const dt = Math.min(0.05, Math.max(0, (now - previous) / 1000));
      previous = now;
      engine.step(dt);
      handleEvents();
      updateParticles(dt);
      drawScene(ctx, engine, particles, now, reducedMotion, shake);
      syncHud();
      win.requestAnimationFrame(frame);
    }

    syncHud();
    win.requestAnimationFrame(frame);
    return { engine, resetGame, advanceLevel, toggleSound };
  }

  if (typeof window !== "undefined" && window.document) {
    const start = function () {
      window.FlockshotGame = createBrowserGame(window.document);
    };
    if (window.document.readyState === "loading") {
      window.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  return {
    WIDTH,
    HEIGHT,
    GROUND_Y,
    ORIGIN: { ...ORIGIN },
    LEVELS,
    clamp,
    circleRectCollision,
    GameEngine,
    createBrowserGame
  };
});
