(function startFowlPlay() {
  "use strict";

  const Core = window.FowlPlayCore;
  const canvas = document.querySelector("#gameCanvas");
  const ctx = canvas.getContext("2d");
  const dom = {
    startPanel: document.querySelector("#startPanel"),
    startButton: document.querySelector("#startButton"),
    resultPanel: document.querySelector("#resultPanel"),
    resultMark: document.querySelector("#resultMark"),
    resultTitle: document.querySelector("#resultTitle"),
    resultCopy: document.querySelector("#resultCopy"),
    resultScore: document.querySelector("#resultScore"),
    replayButton: document.querySelector("#replayButton"),
    restartButton: document.querySelector("#restartButton"),
    soundButton: document.querySelector("#soundButton"),
    score: document.querySelector("#scoreValue"),
    birds: document.querySelector("#birdsValue"),
    statusTitle: document.querySelector("#statusTitle"),
    statusDetail: document.querySelector("#statusDetail"),
  };

  const COLORS = {
    ink: "#13263D",
    sky: "#7AD7E6",
    coral: "#F45F4E",
    sun: "#FFD166",
    paper: "#F7F0DF",
    leaf: "#52B788",
    blue: "#253B80",
    wood: "#B96F58",
    woodLight: "#E5A474",
    ice: "#B1E7E5",
    grass: "#3D8D67",
    hill: "#6AB899",
    nightHill: "#477E83",
  };

  const BIRD_TYPES = ["ruby", "sunny", "ruby", "sunny"];
  const MAX_BIRDS = BIRD_TYPES.length;
  const POWER = 6;
  const IMPACT_SCORE = 150;
  const COMBO_RADIUS = 145;

  const state = {
    width: 0,
    height: 0,
    dpr: 1,
    layout: null,
    targets: [],
    blocks: [],
    readyBird: null,
    flyingBird: null,
    impactBird: null,
    particles: [],
    floaters: [],
    clouds: [],
    mode: "start",
    score: 0,
    bestScore: readBestScore(),
    birdsRemaining: MAX_BIRDS,
    birdsUsed: 0,
    shotAge: 0,
    dragging: false,
    pointerId: null,
    aimPoint: null,
    lastFrame: performance.now(),
    time: 0,
    shake: 0,
    flash: 0,
    timer: null,
    roundWon: false,
    soundEnabled: true,
    audioContext: null,
  };

  function readBestScore() {
    try {
      return Number(window.localStorage.getItem("fowl-play-best")) || 0;
    } catch {
      return 0;
    }
  }

  function saveBestScore() {
    try {
      window.localStorage.setItem("fowl-play-best", String(state.bestScore));
    } catch {
      // Private file contexts may refuse storage; a best score is optional.
    }
  }

  function setCanvasState(value) {
    canvas.dataset.state = value;
  }

  function updateHud() {
    dom.score.textContent = String(state.score);
    dom.score.dataset.score = String(state.score);
    dom.birds.textContent = String(state.birdsRemaining);
    dom.birds.dataset.birds = String(state.birdsRemaining);
  }

  function updateStatus(title, detail) {
    dom.statusTitle.textContent = title;
    dom.statusDetail.textContent = detail;
  }

  function clearTimer() {
    if (state.timer) window.clearTimeout(state.timer);
    state.timer = null;
  }

  function getBirdY() {
    return state.layout?.sling.y ?? state.height - 170;
  }

  function newClouds() {
    const count = state.width < 600 ? 4 : 7;
    return Array.from({ length: count }, (_, index) => ({
      x: (index * 211 + 70) % (state.width + 180) - 90,
      y: 84 + (index % 3) * 67,
      scale: 0.7 + (index % 2) * 0.22,
      speed: 3 + (index % 3) * 1.4,
    }));
  }

  function buildScene() {
    const level = Core.createLevel(state.width, state.height);
    state.layout = level.layout;
    state.targets = level.targets;
    state.blocks = level.blocks;
    state.readyBird = Core.createBird(state.layout.sling.x, getBirdY(), BIRD_TYPES[state.birdsUsed % BIRD_TYPES.length]);
    state.flyingBird = null;
    state.impactBird = null;
    state.aimPoint = { x: state.layout.sling.x, y: state.layout.sling.y };
    state.clouds = newClouds();
  }

  function resetRound(showStart) {
    clearTimer();
    state.score = 0;
    state.birdsRemaining = MAX_BIRDS;
    state.birdsUsed = 0;
    state.shotAge = 0;
    state.dragging = false;
    state.pointerId = null;
    state.particles = [];
    state.floaters = [];
    state.roundWon = false;
    state.flash = 0;
    buildScene();
    state.mode = showStart ? "start" : "playing";
    dom.startPanel.hidden = !showStart;
    dom.resultPanel.hidden = true;
    setCanvasState(showStart ? "start" : "playing");
    updateHud();
    updateStatus(showStart ? "Ready when you are." : "Pick a lane.", "Pull the bird back, then let go.");
  }

  function startRound() {
    ensureAudio();
    resetRound(false);
    dom.startPanel.hidden = true;
    canvas.focus({ preventScroll: true });
    updateStatus("Pick a lane.", "Pull the bird back, then let go.");
    playTone(420, 0.09, "triangle", 0.035);
  }

  function loadNextBird() {
    if (state.birdsRemaining <= 0) {
      finishRound(false);
      return;
    }
    state.readyBird = Core.createBird(
      state.layout.sling.x,
      state.layout.sling.y,
      BIRD_TYPES[state.birdsUsed % BIRD_TYPES.length],
    );
    state.aimPoint = { x: state.layout.sling.x, y: state.layout.sling.y };
    state.mode = "ready";
    setCanvasState("ready");
    updateStatus("Next bird up.", "Pull back and chase the combo.");
  }

  function getCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function isBirdGrabbed(point) {
    return Boolean(
      state.readyBird &&
      Core.distance(point, state.readyBird) <= state.readyBird.radius + 28,
    );
  }

  function beginAim(event) {
    if (!state.readyBird || !["playing", "ready"].includes(state.mode)) return;
    const point = getCanvasPoint(event);
    if (!isBirdGrabbed(point)) return;
    event.preventDefault();
    ensureAudio();
    state.dragging = true;
    state.pointerId = event.pointerId;
    state.mode = "aiming";
    setCanvasState("dragging");
    canvas.setPointerCapture(event.pointerId);
    updateAim(point);
    updateStatus("Aim locked.", "Find the soft spot, then let go.");
    playTone(250, 0.05, "sine", 0.018);
  }

  function updateAim(point) {
    if (!state.dragging || !state.layout) return;
    state.aimPoint = Core.clampAim(state.layout.sling, point, state.layout.maxStretch);
    state.readyBird.x = state.aimPoint.x;
    state.readyBird.y = state.aimPoint.y;
  }

  function cancelAim() {
    if ((!state.dragging && state.mode !== "aiming") || !state.readyBird) return;
    state.dragging = false;
    state.pointerId = null;
    state.readyBird.x = state.layout.sling.x;
    state.readyBird.y = state.layout.sling.y;
    state.aimPoint = { x: state.layout.sling.x, y: state.layout.sling.y };
    state.mode = state.birdsUsed === 0 ? "playing" : "ready";
    setCanvasState(state.mode);
    updateStatus("Try another angle.", "Pull farther for more lift.");
  }

  function endAim(event) {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    const releasePoint = state.aimPoint;
    state.dragging = false;
    state.pointerId = null;
    if (!releasePoint || Core.distance(releasePoint, state.layout.sling) < 18) {
      cancelAim();
      return;
    }
    launchBird(releasePoint);
  }

  function launchBird(releasePoint) {
    const velocity = Core.launchVelocity(state.layout.sling, releasePoint, POWER);
    state.flyingBird = {
      ...state.readyBird,
      x: releasePoint.x,
      y: releasePoint.y,
      vx: velocity.vx,
      vy: velocity.vy,
      trail: [],
      alpha: 1,
    };
    state.readyBird = null;
    state.birdsRemaining -= 1;
    state.birdsUsed += 1;
    state.shotAge = 0;
    state.mode = "flight";
    setCanvasState("flight");
    updateHud();
    updateStatus("Bird in the air!", "Watch the bounce and the score.");
    playTone(160, 0.17, "square", 0.045);
  }

  function updateFlight(delta) {
    const bird = state.flyingBird;
    if (!bird) return;
    state.shotAge += delta;
    bird.trail.push({ x: bird.x, y: bird.y, alpha: 1 });
    if (bird.trail.length > 12) bird.trail.shift();
    Core.stepBody(bird, delta, state.layout.gravity);
    bird.rotation += bird.vx * delta * 0.002;

    const target = state.targets.find(
      (entry) => entry.alive && Core.circleIntersectsCircle(bird, entry),
    );
    if (target) {
      triggerTargetCombo(target, bird);
      settleFlight();
      return;
    }

    const block = state.blocks.find(
      (entry) => entry.alive && Core.circleIntersectsRect(bird, entry),
    );
    if (block) {
      breakBlock(block, bird);
    }

    if (bird.y + bird.radius >= state.layout.groundY) {
      bird.y = state.layout.groundY - bird.radius;
      if (Math.abs(bird.vy) > 105) {
        bird.vy = -Math.abs(bird.vy) * 0.28;
        bird.vx *= 0.72;
        spawnBurst(bird.x, state.layout.groundY, COLORS.paper, 5, "dust");
      } else {
        settleFlight();
        return;
      }
    }

    if (Core.isOutOfBounds(bird, state.width, state.height) || state.shotAge > 8) {
      settleFlight();
    }
  }

  function triggerTargetCombo(target, bird) {
    const victims = state.targets.filter(
      (entry) => entry.alive && Core.distance(target, entry) <= COMBO_RADIUS,
    );
    victims.forEach((entry) => {
      entry.alive = false;
      state.score += IMPACT_SCORE;
      addFloater(entry.x, entry.y - entry.radius - 8, `+${IMPACT_SCORE}`);
      spawnBurst(entry.x, entry.y, COLORS.leaf, 14, "leaf");
    });
    state.blocks.forEach((block) => {
      const center = { x: block.x + block.width / 2, y: block.y + block.height / 2 };
      if (block.alive && Core.distance(target, center) <= COMBO_RADIUS + 24) {
        block.alive = false;
        spawnBurst(center.x, center.y, block.material === "ice" ? COLORS.ice : COLORS.woodLight, 10, "square");
      }
    });
    state.roundWon = state.targets.every((entry) => !entry.alive);
    state.shake = 11;
    state.flash = 0.32;
    spawnBurst(bird.x, bird.y, COLORS.sun, 24, "star");
    addFloater(bird.x, bird.y - 42, "COMBO!");
    updateHud();
    updateStatus("Combo landed.", state.roundWon ? "The yard is officially a mess." : "Nice hit. Keep the pressure on.");
    playTone(state.roundWon ? 720 : 540, 0.2, "triangle", 0.06);
  }

  function breakBlock(block, bird) {
    block.alive = false;
    bird.vx *= 0.68;
    bird.vy *= -0.34;
    state.shake = Math.max(state.shake, 5);
    spawnBurst(block.x + block.width / 2, block.y + block.height / 2, block.material === "ice" ? COLORS.ice : COLORS.woodLight, 10, "square");
    addFloater(block.x + block.width / 2, block.y - 8, "CRACK!");
    playTone(105, 0.08, "sawtooth", 0.035);
  }

  function settleFlight() {
    if (!state.flyingBird) return;
    state.impactBird = { ...state.flyingBird, impactAge: 0 };
    state.flyingBird = null;
    state.mode = "settled";
    setCanvasState("settled");
    updateStatus(state.roundWon ? "Perfect wreckage." : "Shot settled.", state.roundWon ? "Check the round report." : "Next bird loading...");
    state.timer = window.setTimeout(() => {
      state.timer = null;
      if (state.roundWon) finishRound(true);
      else loadNextBird();
    }, state.roundWon ? 700 : state.birdsRemaining > 0 ? 820 : 650);
  }

  function finishRound(won) {
    clearTimer();
    state.mode = "result";
    state.roundWon = won;
    setCanvasState("result");
    dom.startPanel.hidden = true;
    dom.resultPanel.hidden = false;
    dom.resultMark.textContent = won ? "COMBO REPORT" : "ROUND REPORT";
    dom.resultTitle.textContent = won ? "Yard cleared!" : "The tower wins.";
    dom.resultCopy.textContent = won
      ? "That tower just became a very small story."
      : "The goblins are celebrating. Four more feathers could fix that.";
    dom.resultScore.textContent = String(state.score);
    if (state.score > state.bestScore) {
      state.bestScore = state.score;
      saveBestScore();
    }
    updateStatus(won ? "Victory lap." : "Re-group and fling again.", `Best flight-club score: ${state.bestScore}.`);
    playTone(won ? 880 : 120, won ? 0.34 : 0.22, won ? "triangle" : "sawtooth", 0.06);
  }

  function addFloater(x, y, text) {
    state.floaters.push({ x, y, text, life: 1, rise: 0 });
  }

  function spawnBurst(x, y, color, count, shape) {
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count + Math.random() * 0.4;
      const speed = 45 + Math.random() * 130;
      state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 25,
        color,
        shape,
        size: 3 + Math.random() * 5,
        life: 0.55 + Math.random() * 0.45,
        maxLife: 1,
        rotation: Math.random() * Math.PI,
      });
    }
  }

  function updateEffects(delta) {
    state.particles = state.particles.filter((particle) => {
      particle.life -= delta;
      particle.x += particle.vx * delta;
      particle.y += particle.vy * delta;
      particle.vy += 420 * delta;
      particle.rotation += delta * 4;
      return particle.life > 0;
    });
    state.floaters = state.floaters.filter((floater) => {
      floater.life -= delta * 0.72;
      floater.rise += delta * 32;
      return floater.life > 0;
    });
    state.clouds.forEach((cloud) => {
      cloud.x += cloud.speed * delta;
      if (cloud.x > state.width + 140) cloud.x = -150;
    });
    state.shake = Math.max(0, state.shake - delta * 24);
    state.flash = Math.max(0, state.flash - delta * 0.8);
    if (state.impactBird) {
      state.impactBird.impactAge += delta;
      state.impactBird.alpha = Math.max(0, 1 - state.impactBird.impactAge * 1.2);
      if (state.impactBird.alpha === 0) state.impactBird = null;
    }
  }

  function draw() {
    if (!state.layout) return;
    ctx.clearRect(0, 0, state.width, state.height);
    ctx.save();
    if (state.shake > 0) {
      ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
    }
    drawSky();
    drawGround();
    drawBlocks();
    drawTargets();
    drawSling();
    if (state.dragging) drawAimPreview();
    drawTrail();
    if (state.readyBird) drawBird(state.readyBird, 1);
    if (state.flyingBird) drawBird(state.flyingBird, 1);
    if (state.impactBird) drawBird(state.impactBird, state.impactBird.alpha);
    drawEffects();
    ctx.restore();
    if (state.flash > 0) {
      ctx.fillStyle = `rgba(255, 209, 102, ${state.flash * 0.22})`;
      ctx.fillRect(0, 0, state.width, state.height);
    }
  }

  function drawSky() {
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, state.width, state.height);
    ctx.fillStyle = "rgba(255, 245, 205, 0.78)";
    ctx.beginPath();
    ctx.arc(state.width * 0.79, 112, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 245, 205, 0.3)";
    ctx.lineWidth = 2;
    for (let index = 0; index < 8; index += 1) {
      const angle = index * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(state.width * 0.79 + Math.cos(angle) * 62, 112 + Math.sin(angle) * 62);
      ctx.lineTo(state.width * 0.79 + Math.cos(angle) * 76, 112 + Math.sin(angle) * 76);
      ctx.stroke();
    }
    state.clouds.forEach((cloud) => drawCloud(cloud.x, cloud.y, cloud.scale));
    ctx.fillStyle = COLORS.nightHill;
    ctx.beginPath();
    ctx.moveTo(0, state.layout.groundY - 112);
    ctx.quadraticCurveTo(state.width * 0.18, state.layout.groundY - 205, state.width * 0.37, state.layout.groundY - 112);
    ctx.quadraticCurveTo(state.width * 0.62, state.layout.groundY - 228, state.width, state.layout.groundY - 112);
    ctx.lineTo(state.width, state.layout.groundY);
    ctx.lineTo(0, state.layout.groundY);
    ctx.fill();
    ctx.fillStyle = COLORS.hill;
    ctx.beginPath();
    ctx.moveTo(0, state.layout.groundY - 62);
    ctx.quadraticCurveTo(state.width * 0.23, state.layout.groundY - 139, state.width * 0.5, state.layout.groundY - 56);
    ctx.quadraticCurveTo(state.width * 0.74, state.layout.groundY - 124, state.width, state.layout.groundY - 55);
    ctx.lineTo(state.width, state.layout.groundY);
    ctx.lineTo(0, state.layout.groundY);
    ctx.fill();
  }

  function drawCloud(x, y, scale) {
    ctx.fillStyle = "rgba(247, 240, 223, 0.62)";
    ctx.beginPath();
    ctx.ellipse(x, y + 9 * scale, 42 * scale, 13 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 25 * scale, y + 6 * scale, 20 * scale, 13 * scale, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 13 * scale, y - 2 * scale, 25 * scale, 20 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawGround() {
    const ground = state.layout.groundY;
    ctx.fillStyle = COLORS.grass;
    ctx.fillRect(0, ground, state.width, state.height - ground);
    ctx.fillStyle = "rgba(247, 240, 223, 0.22)";
    ctx.fillRect(0, ground, state.width, 5);
    ctx.fillStyle = "rgba(19, 38, 61, 0.16)";
    for (let index = 0; index < Math.ceil(state.width / 28); index += 1) {
      const x = index * 28 + 8;
      ctx.fillRect(x, ground + 21 + (index % 3) * 12, 2, 9);
      ctx.fillRect(x + 5, ground + 17 + (index % 4) * 15, 2, 6);
    }
    ctx.fillStyle = "rgba(255, 209, 102, 0.82)";
    ctx.beginPath();
    ctx.arc(state.width * 0.64, ground + 33, 4, 0, Math.PI * 2);
    ctx.arc(state.width * 0.64 + 12, ground + 26, 3, 0, Math.PI * 2);
    ctx.arc(state.width * 0.64 + 20, ground + 38, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBlocks() {
    state.blocks.filter((block) => block.alive).forEach((block) => {
      ctx.save();
      ctx.translate(block.x, block.y);
      roundedRect(0, 0, block.width, block.height, 5);
      ctx.fillStyle = block.material === "ice" ? COLORS.ice : COLORS.wood;
      ctx.fill();
      ctx.strokeStyle = block.material === "ice" ? "rgba(37, 59, 128, 0.36)" : "rgba(19, 38, 61, 0.34)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = block.material === "ice" ? "rgba(247, 240, 223, 0.7)" : "rgba(247, 240, 223, 0.36)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(9, block.height - 5);
      ctx.lineTo(block.width * 0.42, 5);
      ctx.moveTo(block.width * 0.6, block.height - 4);
      ctx.lineTo(block.width - 10, 5);
      ctx.stroke();
      ctx.restore();
    });
  }

  function drawTargets() {
    state.targets.filter((target) => target.alive).forEach((target, index) => {
      const bob = Math.sin(state.time * 3 + index) * 2;
      drawTarget(target.x, target.y + bob, target.radius);
    });
  }

  function drawTarget(x, y, radius) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(19, 38, 61, 0.19)";
    ctx.beginPath();
    ctx.ellipse(0, radius + 9, radius * 0.9, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.leaf;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(-9, -5, 7, 0, Math.PI * 2);
    ctx.arc(9, -5, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(-8, -4, 3, 0, Math.PI * 2);
    ctx.arc(8, -4, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 7, 8, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.fillStyle = COLORS.leaf;
    ctx.beginPath();
    ctx.ellipse(-15, -radius - 3, 9, 5, -0.5, 0, Math.PI * 2);
    ctx.ellipse(13, -radius - 7, 10, 5, 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawSling() {
    const { sling, groundY } = state.layout;
    const pullPoint = state.dragging && state.aimPoint ? state.aimPoint : state.readyBird || sling;
    ctx.strokeStyle = "rgba(19, 38, 61, 0.2)";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sling.x - 14, groundY + 3);
    ctx.lineTo(sling.x - 17, sling.y - 10);
    ctx.moveTo(sling.x + 14, groundY + 3);
    ctx.lineTo(sling.x + 17, sling.y - 10);
    ctx.stroke();
    ctx.strokeStyle = COLORS.wood;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(sling.x - 14, groundY + 1);
    ctx.lineTo(sling.x - 17, sling.y - 10);
    ctx.moveTo(sling.x + 14, groundY + 1);
    ctx.lineTo(sling.x + 17, sling.y - 10);
    ctx.stroke();
    ctx.strokeStyle = COLORS.blue;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(sling.x - 15, sling.y - 7);
    ctx.lineTo(pullPoint.x, pullPoint.y);
    ctx.lineTo(sling.x + 15, sling.y - 7);
    ctx.stroke();
    ctx.fillStyle = COLORS.sun;
    ctx.beginPath();
    ctx.arc(sling.x, groundY + 4, 19, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 10px Trebuchet MS, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("FLING", sling.x, groundY + 7);
  }

  function drawAimPreview() {
    const point = state.aimPoint;
    const velocity = Core.launchVelocity(state.layout.sling, point, POWER);
    ctx.save();
    ctx.fillStyle = "rgba(247, 240, 223, 0.82)";
    for (let index = 1; index < 16; index += 1) {
      const t = index * 0.1;
      const x = point.x + velocity.vx * t;
      const y = point.y + velocity.vy * t + 0.5 * state.layout.gravity * t * t;
      if (x > state.width + 10 || y > state.height + 10) break;
      ctx.globalAlpha = 1 - index / 20;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2, 5 - index * 0.18), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(37, 59, 128, 0.72)";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.arc(state.layout.sling.x, state.layout.sling.y, state.layout.maxStretch, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawTrail() {
    const bird = state.flyingBird;
    if (!bird?.trail?.length) return;
    bird.trail.forEach((point, index) => {
      ctx.fillStyle = bird.variant === "sunny" ? COLORS.sun : COLORS.coral;
      ctx.globalAlpha = (index + 1) / bird.trail.length * 0.26;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3 + index * 0.3, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawBird(bird, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rotation || 0);
    const bodyColor = bird.variant === "sunny" ? COLORS.sun : COLORS.coral;
    const accentColor = bird.variant === "sunny" ? COLORS.coral : COLORS.ink;
    ctx.fillStyle = "rgba(19, 38, 61, 0.18)";
    ctx.beginPath();
    ctx.ellipse(2, 26, 22, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.moveTo(-21, 6);
    ctx.lineTo(-35, -4);
    ctx.lineTo(-22, 13);
    ctx.moveTo(-19, 14);
    ctx.lineTo(-31, 18);
    ctx.lineTo(-18, 20);
    ctx.fill();
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, bird.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.paper;
    ctx.beginPath();
    ctx.arc(-9, -7, 8, 0, Math.PI * 2);
    ctx.arc(9, -7, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(-8, -7, 3.5, 0, Math.PI * 2);
    ctx.arc(8, -7, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-18, -16);
    ctx.lineTo(-5, -20);
    ctx.moveTo(5, -20);
    ctx.lineTo(18, -16);
    ctx.stroke();
    ctx.fillStyle = COLORS.sun;
    ctx.beginPath();
    ctx.moveTo(17, 0);
    ctx.lineTo(37, 6);
    ctx.lineTo(17, 12);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (bird.variant === "sunny") {
      ctx.fillStyle = COLORS.coral;
      ctx.beginPath();
      ctx.arc(0, -25, 7, 0.2, Math.PI - 0.2);
      ctx.arc(-8, -25, 5, 0.2, Math.PI - 0.2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawEffects() {
    state.particles.forEach((particle) => {
      ctx.save();
      ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife);
      ctx.translate(particle.x, particle.y);
      ctx.rotate(particle.rotation);
      ctx.fillStyle = particle.color;
      if (particle.shape === "square") {
        ctx.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
      } else if (particle.shape === "star") {
        drawStar(0, 0, particle.size * 1.5, particle.size * 0.55, 5);
      } else if (particle.shape === "leaf") {
        ctx.beginPath();
        ctx.ellipse(0, 0, particle.size * 1.25, particle.size * 0.55, 0.4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, particle.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
    state.floaters.forEach((floater) => {
      ctx.save();
      ctx.globalAlpha = Math.max(0, floater.life);
      ctx.fillStyle = floater.text === "COMBO!" ? COLORS.sun : COLORS.paper;
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 3;
      ctx.font = "900 15px Impact, Arial Black, sans-serif";
      ctx.textAlign = "center";
      ctx.strokeText(floater.text, floater.x, floater.y - floater.rise, 140);
      ctx.fillText(floater.text, floater.x, floater.y - floater.rise, 140);
      ctx.restore();
    });
  }

  function drawStar(x, y, outer, inner, points) {
    ctx.beginPath();
    for (let index = 0; index < points * 2; index += 1) {
      const radius = index % 2 === 0 ? outer : inner;
      const angle = -Math.PI / 2 + index * Math.PI / points;
      const pointX = x + Math.cos(angle) * radius;
      const pointY = y + Math.sin(angle) * radius;
      if (index === 0) ctx.moveTo(pointX, pointY);
      else ctx.lineTo(pointX, pointY);
    }
    ctx.closePath();
    ctx.fill();
  }

  function roundedRect(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function ensureAudio() {
    if (!state.soundEnabled || state.audioContext) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      state.audioContext = new AudioContext();
      if (state.audioContext.state === "suspended") state.audioContext.resume();
    } catch {
      state.audioContext = null;
    }
  }

  function playTone(frequency, duration, type, volume) {
    if (!state.soundEnabled || !state.audioContext) return;
    try {
      const oscillator = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, state.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audioContext.currentTime + duration);
      oscillator.connect(gain).connect(state.audioContext.destination);
      oscillator.start();
      oscillator.stop(state.audioContext.currentTime + duration);
    } catch {
      // Sound is decoration; a blocked audio context never blocks the game.
    }
  }

  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    dom.soundButton.setAttribute("aria-pressed", String(state.soundEnabled));
    dom.soundButton.title = state.soundEnabled ? "Mute sound" : "Turn sound on";
    updateStatus(state.soundEnabled ? "Sound on." : "Sound off.", "Your fling controls still work.");
    if (state.soundEnabled) {
      ensureAudio();
      playTone(520, 0.08, "triangle", 0.03);
    }
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    state.width = Math.max(1, rect.width);
    state.height = Math.max(1, rect.height);
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(state.width * state.dpr);
    canvas.height = Math.round(state.height * state.dpr);
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    if (!state.layout) return;
    state.layout = Core.getLayout(state.width, state.height);
    if (state.mode !== "flight" && state.mode !== "aiming") {
      const level = Core.createLevel(state.width, state.height);
      state.targets = level.targets;
      state.blocks = level.blocks;
      state.clouds = newClouds();
    }
    if (state.readyBird) {
      state.readyBird.x = state.layout.sling.x;
      state.readyBird.y = state.layout.sling.y;
    }
  }

  function loop(now) {
    const delta = Math.min(0.034, Math.max(0, (now - state.lastFrame) / 1000));
    state.lastFrame = now;
    state.time += delta;
    if (state.mode === "flight") updateFlight(delta);
    updateEffects(delta);
    draw();
    window.requestAnimationFrame(loop);
  }

  canvas.addEventListener("pointerdown", beginAim);
  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerId === state.pointerId) updateAim(getCanvasPoint(event));
  });
  canvas.addEventListener("pointerup", endAim);
  canvas.addEventListener("pointercancel", cancelAim);
  canvas.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "r") resetRound(true);
    if (event.code === "Space" && state.readyBird) {
      event.preventDefault();
      launchBird({ x: state.layout.sling.x - 88, y: state.layout.sling.y - 72 });
    }
  });
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("blur", cancelAim);
  dom.startButton.addEventListener("click", startRound);
  dom.replayButton.addEventListener("click", startRound);
  dom.restartButton.addEventListener("click", () => resetRound(true));
  dom.soundButton.addEventListener("click", toggleSound);

  resizeCanvas();
  resetRound(true);
  window.requestAnimationFrame(loop);
})();
