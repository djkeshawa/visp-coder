const {
  clamp,
  distance,
  magnitude,
  circleRectCollision,
  resolveCircleRectCollision,
  stepProjectile,
  impactScore,
} = window.FuryPhysics;

const canvas = document.querySelector('#gameCanvas');
const context = canvas.getContext('2d');
const introCard = document.querySelector('#introCard');
const resultCard = document.querySelector('#resultCard');
const startButton = document.querySelector('#startButton');
const resultButton = document.querySelector('#resultButton');
const resetButton = document.querySelector('#resetButton');
const soundButton = document.querySelector('#soundButton');
const soundIcon = document.querySelector('#soundIcon');
const soundLabel = document.querySelector('#soundLabel');
const levelValue = document.querySelector('#levelValue');
const scoreValue = document.querySelector('#scoreValue');
const birdValue = document.querySelector('#birdValue');
const statusText = document.querySelector('#statusText');
const levelName = document.querySelector('#levelName');
const tipText = document.querySelector('#tipText');
const resultKicker = document.querySelector('#resultKicker');
const resultTitle = document.querySelector('#resultTitle');
const resultCopy = document.querySelector('#resultCopy');

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const WORLD = {
  left: 30,
  right: WIDTH - 28,
  groundY: 455,
  gravity: 380,
  restitution: 0.46,
};
const SLING = { x: 152, y: 390 };
const MAX_PULL = 96;
const BIRD_RADIUS = 22;
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const LEVELS = [
  {
    name: 'Picnic Panic',
    tip: 'Tip: a soft launch is precise. A hard launch is hilarious.',
    birds: 4,
    pigs: [
      { id: 'p1', x: 752, y: 401, radius: 23 },
      { id: 'p2', x: 833, y: 401, radius: 23 },
    ],
    blocks: [
      { id: 'l1-base', x: 668, y: 421, width: 238, height: 27, health: 1.8 },
      { id: 'l1-left', x: 685, y: 337, width: 25, height: 84, health: 1.2 },
      { id: 'l1-right', x: 864, y: 337, width: 25, height: 84, health: 1.2 },
      { id: 'l1-roof', x: 676, y: 301, width: 222, height: 27, health: 1.45 },
      { id: 'l1-inner', x: 764, y: 354, width: 25, height: 67, health: 0.95 },
    ],
  },
  {
    name: 'Biscuit Bastion',
    tip: 'Tip: the top bird sees everything. The bottom bird causes everything.',
    birds: 4,
    pigs: [
      { id: 'p1', x: 702, y: 407, radius: 22 },
      { id: 'p2', x: 805, y: 345, radius: 21 },
      { id: 'p3', x: 875, y: 407, radius: 22 },
    ],
    blocks: [
      { id: 'l2-left', x: 646, y: 369, width: 25, height: 79, health: 1.35 },
      { id: 'l2-left-top', x: 646, y: 299, width: 25, height: 70, health: 0.95 },
      { id: 'l2-mid', x: 749, y: 369, width: 25, height: 79, health: 1.35 },
      { id: 'l2-mid-top', x: 749, y: 290, width: 25, height: 79, health: 1.1 },
      { id: 'l2-right', x: 851, y: 369, width: 25, height: 79, health: 1.35 },
      { id: 'l2-roof', x: 632, y: 264, width: 244, height: 28, health: 1.65 },
      { id: 'l2-bridge', x: 696, y: 352, width: 155, height: 23, health: 1.1 },
    ],
  },
  {
    name: 'The Big Brunch',
    tip: 'Tip: one perfect ricochet beats three polite throws.',
    birds: 5,
    pigs: [
      { id: 'p1', x: 693, y: 406, radius: 22 },
      { id: 'p2', x: 790, y: 406, radius: 22 },
      { id: 'p3', x: 855, y: 324, radius: 21 },
      { id: 'p4', x: 891, y: 406, radius: 22 },
    ],
    blocks: [
      { id: 'l3-base', x: 638, y: 421, width: 282, height: 27, health: 2 },
      { id: 'l3-left', x: 657, y: 335, width: 24, height: 86, health: 1.2 },
      { id: 'l3-mid', x: 773, y: 347, width: 24, height: 74, health: 1.15 },
      { id: 'l3-right', x: 886, y: 335, width: 24, height: 86, health: 1.2 },
      { id: 'l3-roof', x: 648, y: 305, width: 270, height: 25, health: 1.75 },
      { id: 'l3-top-left', x: 722, y: 250, width: 24, height: 55, health: 0.85 },
      { id: 'l3-top-right', x: 845, y: 250, width: 24, height: 55, health: 0.85 },
      { id: 'l3-top', x: 714, y: 226, width: 164, height: 25, health: 1.25 },
    ],
  },
];

const state = {
  screen: 'menu',
  levelIndex: 0,
  level: LEVELS[0],
  score: 0,
  birdsRemaining: LEVELS[0].birds,
  projectile: null,
  aimPoint: { ...SLING },
  aimPower: 0,
  isDragging: false,
  pointerId: null,
  blocks: [],
  pigs: [],
  particles: [],
  floaters: [],
  stars: createStars(),
  pendingResult: null,
  shotCount: 0,
  soundEnabled: true,
  audioContext: null,
  cameraShake: 0,
  lastFrame: 0,
};

function createStars() {
  return [
    [64, 52, 1.2], [112, 137, 1], [203, 68, 1.4], [278, 118, 0.8],
    [353, 43, 1.1], [449, 88, 0.8], [532, 48, 1.2], [617, 131, 0.75],
    [703, 60, 1.1], [823, 132, 1.3], [900, 78, 0.8], [942, 177, 1.15],
  ];
}

function cloneLevel(level) {
  return {
    ...level,
    pigs: level.pigs.map((pig) => ({ ...pig, alive: true })),
    blocks: level.blocks.map((block) => ({ ...block, damage: 0, broken: false })),
  };
}

function setCanvasState(nextState) {
  canvas.dataset.state = nextState;
}

function setStatus(message) {
  statusText.textContent = message;
}

function formatScore(score) {
  return Math.max(0, Math.round(score)).toString().padStart(6, '0');
}

function updateHud() {
  levelValue.textContent = `${state.levelIndex + 1} / ${LEVELS.length}`;
  scoreValue.textContent = formatScore(state.score);
  birdValue.textContent = String(state.birdsRemaining);
  levelName.textContent = state.level.name;
  tipText.textContent = state.level.tip;
}

function setScreen(screen) {
  state.screen = screen;
  introCard.hidden = screen !== 'menu';
  resultCard.hidden = screen !== 'result';

  if (screen === 'menu') setCanvasState('menu');
  if (screen === 'playing' && !state.projectile) setCanvasState('ready');
  if (screen === 'result') setCanvasState('result');
}

function loadLevel(index) {
  state.levelIndex = index;
  state.level = LEVELS[index];
  const level = cloneLevel(state.level);
  state.pigs = level.pigs;
  state.blocks = level.blocks;
  state.birdsRemaining = state.level.birds;
  state.projectile = null;
  state.aimPoint = { ...SLING };
  state.aimPower = 0;
  state.isDragging = false;
  state.pendingResult = null;
  state.particles = [];
  state.floaters = [];
  updateHud();
}

function resetToMenu() {
  state.score = 0;
  state.shotCount = 0;
  loadLevel(0);
  setScreen('menu');
  setStatus('Ready your flock');
  canvas.blur();
}

function startRound() {
  ensureAudio();
  state.score = 0;
  state.shotCount = 0;
  loadLevel(0);
  setScreen('playing');
  setStatus('Pull back the bird and let go');
  canvas.focus();
}

function showResult(kind) {
  state.pendingResult = kind;
  state.projectile = null;
  state.isDragging = false;
  setScreen('result');
  burst(kind === 'lose' ? 520 : 800, 190, kind === 'lose' ? '#f05a4f' : '#ffca66', kind === 'lose' ? 12 : 22);
  playTone(kind === 'lose' ? 180 : 620, kind === 'lose' ? 0.22 : 0.16, kind === 'lose' ? 'sawtooth' : 'triangle');

  if (kind === 'level') {
    resultKicker.textContent = `Level ${state.levelIndex + 1} clear`;
    resultTitle.textContent = 'Snack attack!';
    resultCopy.textContent = `That was ${formatScore(state.score)} points of beautifully targeted chaos.`;
    resultButton.innerHTML = 'Next level <span aria-hidden="true">↗</span>';
  } else if (kind === 'win') {
    resultKicker.textContent = 'Flock legend';
    resultTitle.textContent = 'Brunch defended.';
    resultCopy.textContent = `You cleared the whole supply run with ${formatScore(state.score)} points.`;
    resultButton.innerHTML = 'Play again <span aria-hidden="true">↗</span>';
  } else {
    resultKicker.textContent = 'The snacks won';
    resultTitle.textContent = 'So close.';
    resultCopy.textContent = 'The flock is out of birds, but the picnic is still very playable.';
    resultButton.innerHTML = 'Retry level <span aria-hidden="true">↗</span>';
  }
}

function handleResultAction() {
  ensureAudio();
  if (state.pendingResult === 'level') {
    loadLevel(state.levelIndex + 1);
    setScreen('playing');
    setStatus('New picnic, new problems');
    canvas.focus();
    return;
  }

  if (state.pendingResult === 'win') {
    startRound();
    return;
  }

  loadLevel(state.levelIndex);
  setScreen('playing');
  setStatus('Try a different angle');
  canvas.focus();
}

function pointerToCanvas(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * WIDTH,
    y: ((event.clientY - bounds.top) / bounds.height) * HEIGHT,
  };
}

function setAim(point) {
  const deltaX = point.x - SLING.x;
  const deltaY = point.y - SLING.y;
  const length = Math.hypot(deltaX, deltaY);
  const scale = length > MAX_PULL ? MAX_PULL / length : 1;
  state.aimPoint = {
    x: SLING.x + deltaX * scale,
    y: SLING.y + deltaY * scale,
  };
  state.aimPower = clamp(length / MAX_PULL, 0, 1);
}

function canGrabAt(point) {
  return point.x < 285 && distance(point, SLING) < 125;
}

function beginAim(event) {
  if (state.screen !== 'playing' || state.projectile || state.birdsRemaining <= 0) return;
  const point = pointerToCanvas(event);
  if (!canGrabAt(point)) return;

  ensureAudio();
  state.isDragging = true;
  state.pointerId = event.pointerId;
  setAim(point);
  canvas.setPointerCapture?.(event.pointerId);
  setCanvasState('aiming');
  setStatus('Line it up, then let go');
  event.preventDefault();
}

function moveAim(event) {
  if (!state.isDragging || state.pointerId !== event.pointerId) return;
  setAim(pointerToCanvas(event));
  event.preventDefault();
}

function endAim(event) {
  if (!state.isDragging || state.pointerId !== event.pointerId) return;
  state.isDragging = false;
  canvas.releasePointerCapture?.(event.pointerId);
  state.pointerId = null;
  if (state.aimPower < 0.16) {
    state.aimPoint = { ...SLING };
    state.aimPower = 0;
    setCanvasState('ready');
    setStatus('Pull back a little farther');
    return;
  }
  launchBird();
  event.preventDefault();
}

function launchBird() {
  if (state.screen !== 'playing' || state.projectile || state.birdsRemaining <= 0) return;

  const pullX = SLING.x - state.aimPoint.x;
  const pullY = state.aimPoint.y - SLING.y;
  const launchScale = 5.2;
  const velocity = {
    x: pullX * launchScale,
    y: pullY * launchScale,
  };

  state.projectile = {
    x: state.aimPoint.x,
    y: state.aimPoint.y,
    radius: BIRD_RADIUS,
    vx: velocity.x,
    vy: velocity.y,
    age: 0,
    rotation: 0,
    hitTargets: new Set(),
  };
  state.birdsRemaining -= 1;
  state.shotCount += 1;
  state.aimPoint = { ...SLING };
  state.aimPower = 0;
  setCanvasState('flight');
  setStatus('Make it count');
  updateHud();
  burst(state.projectile.x, state.projectile.y, '#f9a37a', 8);
  playTone(290, 0.11, 'triangle', 0.045, 620);
}

function handleKeyboard(event) {
  if (event.key.toLowerCase() === 'r') {
    resetToMenu();
    return;
  }

  if (state.screen !== 'playing' || state.projectile) return;

  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const direction = {
      ArrowLeft: [-12, 0],
      ArrowRight: [12, 0],
      ArrowUp: [0, -12],
      ArrowDown: [0, 12],
    }[event.key];
    if (!state.isDragging) state.aimPoint = { x: SLING.x - 52, y: SLING.y + 12 };
    state.isDragging = true;
    setAim({ x: state.aimPoint.x + direction[0], y: state.aimPoint.y + direction[1] });
    setCanvasState('aiming');
    setStatus('Keyboard aim ready — press Space');
    event.preventDefault();
    return;
  }

  if (event.code === 'Space') {
    if (!state.isDragging) {
      state.isDragging = true;
      setAim({ x: SLING.x - 64, y: SLING.y + 18 });
    }
    launchBird();
    event.preventDefault();
  }
}

function simulate(deltaSeconds) {
  if (state.screen !== 'playing' || !state.projectile) return;

  const stepCount = Math.min(5, Math.max(1, Math.ceil(deltaSeconds / 0.016)));
  const stepSize = deltaSeconds / stepCount;
  let landed = false;

  for (let step = 0; step < stepCount && state.projectile; step += 1) {
    const result = stepProjectile(state.projectile, stepSize, WORLD);
    state.projectile = result.projectile;
    state.projectile.age += stepSize;
    state.projectile.rotation += state.projectile.vx * stepSize * 0.014;
    landed ||= result.landed;
    handleStructureImpacts();
    if (state.projectile) handlePigImpacts();
  }

  if (state.projectile && (state.projectile.age > 4.2 || (landed && state.projectile.age > 0.55))) {
    endShot();
  }
}

function handleStructureImpacts() {
  if (!state.projectile) return;
  for (const block of state.blocks) {
    if (block.broken || state.projectile.hitTargets.has(block.id)) continue;
    const collision = circleRectCollision(state.projectile, block);
    if (!collision.hit) continue;

    state.projectile.hitTargets.add(block.id);
    const speed = magnitude({ x: state.projectile.vx, y: state.projectile.vy });
    block.damage += clamp(speed / 180, 0.2, 1.5);
    state.score += Math.round(impactScore(speed, 'wood') / 5);
    state.cameraShake = Math.min(7, state.cameraShake + 2.5);
    burst(state.projectile.x, state.projectile.y, '#e8a261', speed > 190 ? 8 : 4);
    floatScore(state.projectile.x, state.projectile.y - 20, `+${Math.round(impactScore(speed, 'wood') / 5)}`);
    playTone(130 + clamp(speed, 80, 260), 0.07, 'square', 0.025);

    if (block.damage >= block.health) {
      block.broken = true;
      state.projectile.vx *= 0.94;
      state.projectile.vy *= 0.94;
      state.score += impactScore(speed, 'wood');
      floatScore(block.x + block.width / 2, block.y, `+${impactScore(speed, 'wood')}`);
      burst(block.x + block.width / 2, block.y + block.height / 2, '#c88d56', 15);
      playTone(190, 0.1, 'sawtooth', 0.03, 90);
    } else {
      const resolution = resolveCircleRectCollision(
        state.projectile,
        { x: state.projectile.vx, y: state.projectile.vy },
        block,
        0.35,
      );
      state.projectile.x = resolution.position.x;
      state.projectile.y = resolution.position.y;
      state.projectile.vx = resolution.velocity.x;
      state.projectile.vy = resolution.velocity.y;
    }
    updateHud();
  }
}

function handlePigImpacts() {
  if (!state.projectile) return;
  for (const pig of state.pigs) {
    if (!pig.alive || state.projectile.hitTargets.has(pig.id)) continue;
    if (distance(state.projectile, pig) > state.projectile.radius + pig.radius) continue;

    state.projectile.hitTargets.add(pig.id);
    const speed = magnitude({ x: state.projectile.vx, y: state.projectile.vy });
    const points = impactScore(speed, 'pig');
    pig.alive = false;
    state.score += points;
    state.cameraShake = Math.min(11, state.cameraShake + 5);
    burst(pig.x, pig.y, '#84d8a1', 18);
    floatScore(pig.x, pig.y - 34, `+${points}`);
    setStatus('Direct hit! Keep the chaos going');
    playTone(520, 0.12, 'triangle', 0.045, 880);
    updateHud();

    if (state.pigs.every((target) => !target.alive)) {
      state.score += state.birdsRemaining * 75;
      updateHud();
      window.setTimeout(() => showResult(state.levelIndex === LEVELS.length - 1 ? 'win' : 'level'), REDUCED_MOTION ? 0 : 420);
      return;
    }
  }
}

function endShot() {
  if (!state.projectile) return;
  state.projectile = null;
  state.aimPoint = { ...SLING };
  state.aimPower = 0;

  if (state.pigs.every((pig) => !pig.alive)) return;

  if (state.birdsRemaining <= 0) {
    showResult('lose');
    return;
  }

  setCanvasState('ready');
  setStatus('Next bird, new angle');
}

function burst(x, y, color, count = 8) {
  const particleCount = REDUCED_MOTION ? Math.ceil(count / 3) : count;
  for (let index = 0; index < particleCount; index += 1) {
    const angle = (Math.PI * 2 * index) / particleCount + Math.random() * 0.35;
    const speed = 40 + Math.random() * 130;
    state.particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      size: 2 + Math.random() * 4,
      color,
      life: 0.4 + Math.random() * 0.35,
      maxLife: 0.7,
    });
  }
}

function floatScore(x, y, text) {
  state.floaters.push({ x, y, text, life: 0.9, maxLife: 0.9 });
}

function updateEffects(deltaSeconds) {
  state.cameraShake *= Math.pow(0.04, deltaSeconds);
  state.particles = state.particles.filter((particle) => {
    particle.life -= deltaSeconds;
    particle.x += particle.vx * deltaSeconds;
    particle.y += particle.vy * deltaSeconds;
    particle.vy += 270 * deltaSeconds;
    return particle.life > 0;
  });
  state.floaters = state.floaters.filter((floater) => {
    floater.life -= deltaSeconds;
    floater.y -= 28 * deltaSeconds;
    return floater.life > 0;
  });
}

function ensureAudio() {
  if (!state.soundEnabled || state.audioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  state.audioContext = new AudioContext();
}

function playTone(frequency, duration, type = 'sine', volume = 0.035, endFrequency = frequency) {
  if (!state.soundEnabled || !state.audioContext) return;
  const now = state.audioContext.currentTime;
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), now + duration);
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain);
  gain.connect(state.audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration + 0.02);
}

function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  soundButton.setAttribute('aria-pressed', String(state.soundEnabled));
  soundIcon.textContent = state.soundEnabled ? '◖' : '—';
  soundLabel.textContent = state.soundEnabled ? 'Sound on' : 'Sound off';
  if (state.soundEnabled) {
    ensureAudio();
    playTone(540, 0.08, 'sine', 0.035, 720);
  }
}

function roundedRect(x, y, width, height, radius) {
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(x, y, width, height, radius);
  } else {
    context.rect(x, y, width, height);
  }
}

function drawBackground() {
  const sky = context.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, '#151f3d');
  sky.addColorStop(0.56, '#26345a');
  sky.addColorStop(1, '#394b68');
  context.fillStyle = sky;
  context.fillRect(0, 0, WIDTH, HEIGHT);

  const glow = context.createRadialGradient(760, 105, 5, 760, 105, 125);
  glow.addColorStop(0, 'rgba(255, 202, 102, 0.72)');
  glow.addColorStop(0.38, 'rgba(255, 202, 102, 0.18)');
  glow.addColorStop(1, 'rgba(255, 202, 102, 0)');
  context.fillStyle = glow;
  context.fillRect(620, 0, 280, 245);

  context.fillStyle = '#ffca66';
  context.beginPath();
  context.arc(760, 105, 45, 0, Math.PI * 2);
  context.fill();

  for (const [x, y, radius] of state.stars) {
    context.globalAlpha = 0.4 + radius * 0.35;
    context.fillStyle = '#fff8ea';
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

  drawCloud(188, 132, 0.75);
  drawCloud(532, 182, 0.48);
  drawCloud(862, 206, 0.62);

  context.fillStyle = '#1a2747';
  context.beginPath();
  context.moveTo(0, 366);
  context.quadraticCurveTo(135, 293, 268, 358);
  context.quadraticCurveTo(395, 420, 556, 342);
  context.quadraticCurveTo(704, 276, 960, 352);
  context.lineTo(960, HEIGHT);
  context.lineTo(0, HEIGHT);
  context.closePath();
  context.fill();

  context.fillStyle = '#223454';
  context.beginPath();
  context.moveTo(0, 407);
  context.quadraticCurveTo(168, 345, 300, 407);
  context.quadraticCurveTo(440, 460, 632, 388);
  context.quadraticCurveTo(790, 333, 960, 405);
  context.lineTo(960, HEIGHT);
  context.lineTo(0, HEIGHT);
  context.closePath();
  context.fill();

  const ground = context.createLinearGradient(0, WORLD.groundY, 0, HEIGHT);
  ground.addColorStop(0, '#446b64');
  ground.addColorStop(1, '#203b46');
  context.fillStyle = ground;
  context.fillRect(0, WORLD.groundY, WIDTH, HEIGHT - WORLD.groundY);
  context.fillStyle = '#84d8a1';
  context.fillRect(0, WORLD.groundY, WIDTH, 4);

  context.fillStyle = 'rgba(255, 248, 234, 0.055)';
  for (let x = -20; x < WIDTH; x += 56) {
    context.fillRect(x, WORLD.groundY + 26, 28, 2);
  }
}

function drawCloud(x, y, scale) {
  context.save();
  context.globalAlpha = 0.08;
  context.fillStyle = '#fff8ea';
  context.beginPath();
  context.arc(x, y, 18 * scale, 0, Math.PI * 2);
  context.arc(x + 20 * scale, y - 8 * scale, 26 * scale, 0, Math.PI * 2);
  context.arc(x + 48 * scale, y, 17 * scale, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawLevelObjects() {
  for (const block of state.blocks) {
    if (!block.broken) drawBlock(block);
  }
  for (const pig of state.pigs) {
    if (pig.alive) drawPig(pig);
  }
}

function drawBlock(block) {
  const healthRatio = clamp(block.damage / block.health, 0, 1);
  const wood = context.createLinearGradient(block.x, block.y, block.x, block.y + block.height);
  wood.addColorStop(0, healthRatio > 0.55 ? '#c17a4f' : '#e2a269');
  wood.addColorStop(1, '#9c5f47');
  context.save();
  roundedRect(block.x, block.y, block.width, block.height, 5);
  context.fillStyle = wood;
  context.fill();
  context.strokeStyle = 'rgba(55, 35, 39, 0.44)';
  context.lineWidth = 2;
  context.stroke();

  context.globalAlpha = 0.22;
  context.strokeStyle = '#fff8ea';
  context.lineWidth = 2;
  context.beginPath();
  if (block.width > block.height) {
    context.moveTo(block.x + 14, block.y + block.height / 2);
    context.lineTo(block.x + block.width - 14, block.y + block.height / 2);
  } else {
    context.moveTo(block.x + block.width / 2, block.y + 10);
    context.lineTo(block.x + block.width / 2, block.y + block.height - 10);
  }
  context.stroke();
  context.globalAlpha = 1;

  drawBolt(block.x + 7, block.y + 7);
  drawBolt(block.x + block.width - 7, block.y + block.height - 7);

  if (healthRatio > 0.24) {
    context.strokeStyle = `rgba(65, 37, 42, ${0.2 + healthRatio * 0.6})`;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(block.x + block.width * 0.42, block.y + block.height * 0.2);
    context.lineTo(block.x + block.width * 0.53, block.y + block.height * 0.48);
    context.lineTo(block.x + block.width * 0.43, block.y + block.height * 0.78);
    context.stroke();
  }
  context.restore();
}

function drawBolt(x, y) {
  context.fillStyle = '#f5cb84';
  context.beginPath();
  context.arc(x, y, 2.7, 0, Math.PI * 2);
  context.fill();
}

function drawPig(pig) {
  context.save();
  context.translate(pig.x, pig.y);
  context.fillStyle = 'rgba(8, 16, 27, 0.22)';
  context.beginPath();
  context.ellipse(0, pig.radius + 8, pig.radius * 0.9, 7, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#84d8a1';
  context.beginPath();
  context.arc(0, 0, pig.radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#3f916d';
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = '#73c891';
  context.beginPath();
  context.moveTo(-pig.radius * 0.72, -pig.radius * 0.58);
  context.lineTo(-pig.radius * 0.94, -pig.radius * 1.2);
  context.lineTo(-pig.radius * 0.34, -pig.radius * 0.95);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(pig.radius * 0.72, -pig.radius * 0.58);
  context.lineTo(pig.radius * 0.94, -pig.radius * 1.2);
  context.lineTo(pig.radius * 0.34, -pig.radius * 0.95);
  context.closePath();
  context.fill();

  context.fillStyle = '#122039';
  context.beginPath();
  context.arc(-8, -5, 3.8, 0, Math.PI * 2);
  context.arc(8, -5, 3.8, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#d8f0c3';
  context.beginPath();
  context.arc(-7, -6, 1.3, 0, Math.PI * 2);
  context.arc(9, -6, 1.3, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#9be3ac';
  context.beginPath();
  context.ellipse(0, 8, 11, 7, 0, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#3f916d';
  context.lineWidth = 1.5;
  context.stroke();
  context.fillStyle = '#3f916d';
  context.beginPath();
  context.arc(-4, 8, 1.9, 0, Math.PI * 2);
  context.arc(4, 8, 1.9, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawSling() {
  context.save();
  context.strokeStyle = 'rgba(8, 16, 27, 0.24)';
  context.lineWidth = 11;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(126, WORLD.groundY + 4);
  context.lineTo(150, SLING.y + 6);
  context.lineTo(174, WORLD.groundY + 4);
  context.stroke();

  context.strokeStyle = '#a86047';
  context.lineWidth = 8;
  context.beginPath();
  context.moveTo(126, WORLD.groundY + 2);
  context.lineTo(150, SLING.y + 5);
  context.lineTo(174, WORLD.groundY + 2);
  context.stroke();
  context.strokeStyle = '#e2a269';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(128, WORLD.groundY - 1);
  context.lineTo(150, SLING.y + 6);
  context.lineTo(172, WORLD.groundY - 1);
  context.stroke();

  if (!state.projectile && state.screen === 'playing') {
    context.strokeStyle = '#4b2d35';
    context.lineWidth = 5;
    context.beginPath();
    context.moveTo(150, SLING.y - 3);
    context.lineTo(state.aimPoint.x, state.aimPoint.y);
    context.lineTo(150, SLING.y + 6);
    context.stroke();
  }
  context.restore();
}

function drawAimGuide() {
  if (state.screen !== 'playing' || state.projectile || state.aimPower < 0.12) return;
  const pullX = SLING.x - state.aimPoint.x;
  const pullY = state.aimPoint.y - SLING.y;
  const velocity = { x: pullX * 5.2, y: pullY * 5.2 };
  context.save();
  context.fillStyle = 'rgba(255, 248, 234, 0.55)';
  for (let index = 1; index <= 9; index += 1) {
    const time = index * 0.13;
    const x = state.aimPoint.x + velocity.x * time;
    const y = state.aimPoint.y + velocity.y * time + 0.5 * WORLD.gravity * time * time;
    if (x > WIDTH || y > WORLD.groundY) break;
    context.globalAlpha = Math.max(0.1, 0.62 - index * 0.055);
    context.beginPath();
    context.arc(x, y, Math.max(2, 5 - index * 0.3), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawBird(bird, rotation = 0) {
  context.save();
  context.translate(bird.x, bird.y);
  context.rotate(rotation);
  context.fillStyle = 'rgba(8, 16, 27, 0.24)';
  context.beginPath();
  context.ellipse(3, bird.radius + 9, bird.radius * 0.85, 6, 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#f05a4f';
  context.beginPath();
  context.arc(0, 0, bird.radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#b63f3f';
  context.lineWidth = 3;
  context.stroke();

  context.fillStyle = '#c9413e';
  context.beginPath();
  context.moveTo(-13, -14);
  context.lineTo(-6, -30);
  context.lineTo(0, -15);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(-1, -16);
  context.lineTo(8, -30);
  context.lineTo(10, -12);
  context.closePath();
  context.fill();

  context.strokeStyle = '#331f2b';
  context.lineWidth = 5;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(-15, -8);
  context.lineTo(-3, -12);
  context.moveTo(2, -12);
  context.lineTo(14, -8);
  context.stroke();

  context.fillStyle = '#fff8ea';
  context.beginPath();
  context.arc(-9, -1, 7, 0, Math.PI * 2);
  context.arc(9, -1, 7, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#17213b';
  context.beginPath();
  context.arc(-7, 0, 3.2, 0, Math.PI * 2);
  context.arc(7, 0, 3.2, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#ffca66';
  context.beginPath();
  context.moveTo(10, 7);
  context.lineTo(31, 13);
  context.lineTo(10, 19);
  context.closePath();
  context.fill();
  context.strokeStyle = '#bb713f';
  context.lineWidth = 2;
  context.stroke();

  context.fillStyle = '#f7a07a';
  context.beginPath();
  context.arc(-15, 11, 4, 0, Math.PI * 2);
  context.arc(2, 15, 4, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawEffects() {
  for (const particle of state.particles) {
    context.globalAlpha = clamp(particle.life / particle.maxLife, 0, 1);
    context.fillStyle = particle.color;
    context.save();
    context.translate(particle.x, particle.y);
    context.rotate(particle.life * 4);
    context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
    context.restore();
  }
  context.globalAlpha = 1;

  context.save();
  context.font = '900 16px Trebuchet MS, sans-serif';
  context.textAlign = 'center';
  for (const floater of state.floaters) {
    context.globalAlpha = clamp(floater.life / floater.maxLife, 0, 1);
    context.fillStyle = '#ffca66';
    context.strokeStyle = '#17213b';
    context.lineWidth = 4;
    context.strokeText(floater.text, floater.x, floater.y);
    context.fillText(floater.text, floater.x, floater.y);
  }
  context.restore();
  context.globalAlpha = 1;
}

function draw() {
  context.save();
  if (!REDUCED_MOTION && state.cameraShake > 0.1) {
    context.translate((Math.random() - 0.5) * state.cameraShake, (Math.random() - 0.5) * state.cameraShake);
  }
  context.clearRect(-15, -15, WIDTH + 30, HEIGHT + 30);
  drawBackground();
  drawLevelObjects();
  drawSling();
  drawAimGuide();

  if (state.projectile) {
    drawBird(state.projectile, state.projectile.rotation);
  } else if (state.screen === 'playing') {
    drawBird({ x: state.aimPoint.x, y: state.aimPoint.y, radius: BIRD_RADIUS }, 0);
  }
  drawEffects();
  context.restore();
}

function frame(timestamp) {
  const deltaSeconds = Math.min(0.035, (timestamp - state.lastFrame) / 1000 || 0);
  state.lastFrame = timestamp;
  updateEffects(deltaSeconds);
  simulate(deltaSeconds);
  draw();
  window.requestAnimationFrame(frame);
}

startButton.addEventListener('click', startRound);
resultButton.addEventListener('click', handleResultAction);
resetButton.addEventListener('click', resetToMenu);
soundButton.addEventListener('click', toggleSound);
canvas.addEventListener('pointerdown', beginAim);
canvas.addEventListener('pointermove', moveAim);
canvas.addEventListener('pointerup', endAim);
canvas.addEventListener('pointercancel', endAim);
canvas.addEventListener('keydown', handleKeyboard);

loadLevel(0);
setScreen('menu');
setStatus('Ready your flock');
updateHud();
window.requestAnimationFrame(frame);
