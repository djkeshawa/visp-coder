(() => {
  'use strict';

  const core = window.GameCore;
  const canvas = document.getElementById('gameCanvas');
  const context = canvas.getContext('2d');
  const refs = {
    level: document.getElementById('levelValue'),
    score: document.getElementById('scoreValue'),
    birds: document.getElementById('birdsValue'),
    levelTitle: document.getElementById('levelTitle'),
    missionText: document.getElementById('missionText'),
    targetCount: document.getElementById('targetCount'),
    liveMessage: document.getElementById('liveMessage'),
    panel: document.getElementById('missionPanel'),
    panelEyebrow: document.getElementById('panelEyebrow'),
    panelTitle: document.getElementById('panelTitle'),
    panelCopy: document.getElementById('panelCopy'),
    startButton: document.getElementById('startButton'),
    resetButton: document.getElementById('resetButton'),
    muteButton: document.getElementById('muteButton'),
    abilityButton: document.getElementById('abilityButton'),
    abilityIcon: document.getElementById('abilityIcon'),
    abilityName: document.getElementById('abilityName'),
    abilityText: document.getElementById('abilityText'),
  };

  const WORLD = { width: 1200, height: 640, groundY: 548, gravity: 700 };
  const SLING = { x: 158, y: 470, maxPull: 94 };
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const soundStorageKey = 'moonshot-flock-muted';

  function readMutePreference() {
    try {
      return localStorage.getItem(soundStorageKey) === 'true';
    } catch {
      return false;
    }
  }

  const BIRD_TYPES = {
    red: {
      label: 'Crimson',
      color: '#ff6b5b',
      shade: '#c94c50',
      ability: 'Rage boost',
      abilityIcon: '↗',
      hint: 'Turn speed into a bigger bonk.',
    },
    blue: {
      label: 'Azure',
      color: '#66cbed',
      shade: '#3984b2',
      ability: 'Split shot',
      abilityIcon: '✣',
      hint: 'Split mid-flight for a two-angle surprise.',
    },
    yellow: {
      label: 'Lemon',
      color: '#ffd166',
      shade: '#cf8d42',
      ability: 'Dive bomb',
      abilityIcon: '↓',
      hint: 'Punch down through the tower.',
    },
  };

  const LEVELS = [
    {
      title: 'The Wobble Woods',
      mission: 'The snack stash is under suspiciously flimsy guard.',
      birds: ['red', 'blue', 'yellow', 'red'],
      blocks: [
        { id: 'wood-left', x: 748, y: 448, width: 27, height: 100, material: 'wood', hp: 92 },
        { id: 'wood-right', x: 908, y: 448, width: 27, height: 100, material: 'wood', hp: 92 },
        { id: 'wood-beam', x: 732, y: 421, width: 219, height: 27, material: 'wood', hp: 112 },
        { id: 'glass-left', x: 808, y: 343, width: 24, height: 78, material: 'glass', hp: 58 },
        { id: 'glass-right', x: 870, y: 343, width: 24, height: 78, material: 'glass', hp: 58 },
        { id: 'glass-cap', x: 795, y: 318, width: 112, height: 25, material: 'glass', hp: 66 },
      ],
      pigs: [
        { id: 'pig-ground', x: 840, y: 396, radius: 25 },
        { id: 'pig-top', x: 850, y: 294, radius: 22 },
      ],
    },
    {
      title: 'Moon Market',
      mission: 'Three tiny tyrants. One very throwable flock.',
      birds: ['blue', 'yellow', 'red', 'blue', 'yellow'],
      blocks: [
        { id: 'stone-pillar', x: 764, y: 430, width: 31, height: 118, material: 'stone', hp: 134 },
        { id: 'wood-pillar', x: 928, y: 430, width: 31, height: 118, material: 'wood', hp: 96 },
        { id: 'wood-low-beam', x: 748, y: 398, width: 211, height: 28, material: 'wood', hp: 105 },
        { id: 'glass-mid-left', x: 795, y: 305, width: 23, height: 93, material: 'glass', hp: 64 },
        { id: 'glass-mid-right', x: 891, y: 305, width: 23, height: 93, material: 'glass', hp: 64 },
        { id: 'stone-mid-beam', x: 782, y: 276, width: 145, height: 29, material: 'stone', hp: 122 },
        { id: 'wood-top-left', x: 836, y: 207, width: 24, height: 69, material: 'wood', hp: 76 },
        { id: 'wood-top-right', x: 891, y: 207, width: 24, height: 69, material: 'wood', hp: 76 },
        { id: 'wood-top-beam', x: 823, y: 185, width: 105, height: 23, material: 'wood', hp: 86 },
      ],
      pigs: [
        { id: 'pig-low', x: 850, y: 371, radius: 24 },
        { id: 'pig-mid', x: 855, y: 250, radius: 22 },
        { id: 'pig-top', x: 875, y: 158, radius: 21 },
      ],
    },
    {
      title: 'The Snack Moon',
      mission: 'The final stash is guarded by a tower with an attitude.',
      birds: ['yellow', 'red', 'blue', 'yellow', 'red', 'blue'],
      blocks: [
        { id: 'stone-base-left', x: 724, y: 448, width: 30, height: 100, material: 'stone', hp: 138 },
        { id: 'stone-base-right', x: 960, y: 448, width: 30, height: 100, material: 'stone', hp: 138 },
        { id: 'wood-foundation', x: 708, y: 421, width: 296, height: 27, material: 'wood', hp: 120 },
        { id: 'glass-rail-left', x: 760, y: 332, width: 23, height: 89, material: 'glass', hp: 69 },
        { id: 'glass-rail-right', x: 924, y: 332, width: 23, height: 89, material: 'glass', hp: 69 },
        { id: 'wood-center', x: 838, y: 332, width: 29, height: 89, material: 'wood', hp: 87 },
        { id: 'stone-middle', x: 745, y: 304, width: 218, height: 28, material: 'stone', hp: 149 },
        { id: 'wood-high-left', x: 798, y: 214, width: 24, height: 90, material: 'wood', hp: 82 },
        { id: 'wood-high-right', x: 900, y: 214, width: 24, height: 90, material: 'wood', hp: 82 },
        { id: 'glass-high-beam', x: 784, y: 189, width: 155, height: 25, material: 'glass', hp: 73 },
      ],
      pigs: [
        { id: 'pig-left', x: 790, y: 397, radius: 23 },
        { id: 'pig-center', x: 867, y: 275, radius: 25 },
        { id: 'pig-right', x: 933, y: 397, radius: 23 },
        { id: 'pig-top', x: 862, y: 164, radius: 21 },
      ],
    },
  ];

  const state = {
    phase: 'intro',
    started: false,
    levelIndex: 0,
    score: 0,
    levelScore: 0,
    queueIndex: 0,
    currentBird: null,
    projectiles: [],
    blocks: [],
    pigs: [],
    particles: [],
    popups: [],
    dragging: false,
    pointerId: null,
    nextBirdAt: 0,
    muted: readMutePreference(),
    lastFrame: performance.now(),
  };

  const stars = Array.from({ length: 54 }, (_, index) => ({
    x: 22 + ((index * 191) % 1150),
    y: 26 + ((index * 83) % 250),
    size: 1 + (index % 3) * 0.55,
    twinkle: index * 0.63,
  }));

  let renderScale = 1;
  let pixelRatio = 1;
  let audioContext = null;

  function activeLevel() {
    return LEVELS[state.levelIndex];
  }

  function createBird(type, mini = false) {
    return {
      id: `bird-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type,
      x: SLING.x,
      y: SLING.y,
      radius: mini ? 13 : 21,
      vx: 0,
      vy: 0,
      rotation: 0,
      life: 0,
      mini,
      abilityUsed: false,
      settled: false,
      hitIds: new Set(),
    };
  }

  function cloneLevel(index) {
    const blueprint = LEVELS[index];
    state.blocks = blueprint.blocks.map((block) => ({
      ...block,
      maxHp: block.hp,
      active: true,
      shake: 0,
      flash: 0,
      crackSeed: block.id.length * 13,
    }));
    state.pigs = blueprint.pigs.map((pig, pigIndex) => ({
      ...pig,
      phase: pigIndex * 1.7,
      alive: true,
    }));
  }

  function loadLevel(index) {
    state.levelIndex = index;
    state.queueIndex = 0;
    state.projectiles = [];
    state.particles = [];
    state.popups = [];
    state.levelScore = 0;
    state.nextBirdAt = 0;
    state.dragging = false;
    state.pointerId = null;
    cloneLevel(index);
    state.currentBird = createBird(activeLevel().birds[0]);
    setPhase(state.started ? 'ready' : 'intro');
    updateHud();
    if (state.started) {
      hidePanel();
      setMessage(`Level ${index + 1}: ${activeLevel().mission}`);
    } else {
      showPanel('Mission briefing', 'Make a moonshot', 'Drag the bird back, release, and send the moon-pigs packing. Every bird has a trick.', 'Start the flock');
      setMessage('Ready when you are. The moon is watching.');
    }
  }

  function setPhase(phase) {
    state.phase = phase;
    canvas.dataset.state = phase;
    document.body.dataset.state = phase;
    updateAbilityUi();
  }

  function showPanel(eyebrow, title, copy, buttonText) {
    refs.panelEyebrow.textContent = eyebrow;
    refs.panelTitle.textContent = title;
    refs.panelCopy.textContent = copy;
    refs.startButton.textContent = buttonText;
    refs.panel.dataset.visible = 'true';
    refs.panel.setAttribute('aria-hidden', 'false');
  }

  function hidePanel() {
    refs.panel.dataset.visible = 'false';
    refs.panel.setAttribute('aria-hidden', 'true');
  }

  function setMessage(message) {
    refs.liveMessage.textContent = message;
  }

  function updateHud() {
    const level = activeLevel();
    const birdsLeft = Math.max(0, level.birds.length - state.queueIndex);
    const pigCount = state.pigs.length;
    refs.level.textContent = `${state.levelIndex + 1} / ${LEVELS.length}`;
    refs.score.textContent = String(state.score).padStart(5, '0');
    refs.birds.textContent = String(birdsLeft);
    refs.levelTitle.textContent = level.title;
    refs.missionText.textContent = level.mission;
    refs.targetCount.textContent = `${pigCount} moon-pig${pigCount === 1 ? '' : 's'} remain`;
    refs.muteButton.textContent = state.muted ? '⟲' : '♪';
    refs.muteButton.setAttribute('aria-label', state.muted ? 'Unmute sound' : 'Mute sound');
    refs.muteButton.title = state.muted ? 'Unmute sound' : 'Mute sound';
    updateAbilityUi();
  }

  function updateAbilityUi() {
    const bird = state.currentBird || state.projectiles.find((projectile) => !projectile.mini) || state.projectiles[0];
    const info = BIRD_TYPES[bird?.type ?? 'red'];
    refs.abilityIcon.textContent = info.abilityIcon;
    refs.abilityName.textContent = info.ability;
    refs.abilityText.textContent = info.hint;
    refs.abilityButton.innerHTML = `Use ability <kbd>Space</kbd>`;
    refs.abilityButton.disabled = state.phase !== 'flight' || !bird || bird.abilityUsed;
  }

  function ensureAudio() {
    if (state.muted) return null;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      audioContext ??= new AudioContextClass();
      if (audioContext.state === 'suspended') audioContext.resume();
      return audioContext;
    } catch {
      return null;
    }
  }

  function playSound(kind) {
    const audio = ensureAudio();
    if (!audio) return;
    const notes = {
      launch: [[210, 0.08, 'triangle'], [340, 0.12, 'sine']],
      hit: [[120, 0.08, 'square']],
      pig: [[420, 0.08, 'sine'], [650, 0.12, 'triangle']],
      ability: [[280, 0.06, 'sawtooth'], [540, 0.16, 'triangle']],
      win: [[390, 0.1, 'sine'], [520, 0.1, 'sine'], [780, 0.2, 'triangle']],
    }[kind] ?? [];
    let offset = 0;
    notes.forEach(([frequency, duration, wave]) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = wave;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, audio.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.045, audio.currentTime + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + offset + duration);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(audio.currentTime + offset);
      oscillator.stop(audio.currentTime + offset + duration + 0.02);
      offset += duration * 0.72;
    });
  }

  function addScore(amount, x, y, label = `+${amount}`) {
    state.score += amount;
    state.levelScore += amount;
    state.popups.push({ text: label, x, y, color: '#ffd166', life: 1.2, maxLife: 1.2 });
    updateHud();
  }

  function spawnBurst(x, y, colors, count = 14, speed = 190) {
    const total = reducedMotion ? Math.ceil(count * 0.45) : count;
    for (let index = 0; index < total; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.35 + Math.random() * 0.8);
      state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - speed * 0.22,
        life: 0.45 + Math.random() * 0.7,
        maxLife: 1.15,
        size: 3 + Math.random() * 5,
        color: colors[index % colors.length],
        gravity: 240 + Math.random() * 220,
        shape: index % 3,
      });
    }
  }

  function spawnDebris(block) {
    const color = block.material === 'glass' ? '#b9f3ff' : block.material === 'stone' ? '#a79bbd' : '#e0a05e';
    spawnBurst(block.x + block.width / 2, block.y + block.height / 2, [color, '#fff4d6', '#ff6b5b'], 17, 165);
  }

  function damageBlock(block, speed, projectile) {
    const damageFactor = { wood: 0.48, glass: 0.72, stone: 0.3 }[block.material] ?? 0.4;
    const bonus = projectile.type === 'yellow' ? 17 : projectile.type === 'red' ? 7 : 0;
    block.hp -= speed * damageFactor + bonus;
    block.flash = 0.28;
    block.shake = Math.min(1, speed / 240);
    const points = core.impactScore(speed, block.material);
    addScore(points, block.x + block.width / 2, block.y, `+${points}`);
    playSound('hit');
    spawnBurst(block.x + block.width / 2, block.y + block.height / 2, ['#ffd166', '#ff6b5b', '#fff4d6'], 5, 80);
    if (block.hp <= 0) {
      block.active = false;
      addScore(block.material === 'stone' ? 140 : 100, block.x + block.width / 2, block.y + block.height / 2, 'CRACK!');
      spawnDebris(block);
    }
  }

  function defeatPig(pig, projectile) {
    const speed = Math.max(30, Math.hypot(projectile.vx, projectile.vy));
    const points = core.impactScore(speed, 'pig');
    state.pigs = state.pigs.filter((candidate) => candidate.id !== pig.id);
    addScore(points, pig.x, pig.y, `+${points}`);
    spawnBurst(pig.x, pig.y, ['#65e6b2', '#ffd166', '#fff4d6', '#ff6b5b'], 24, 220);
    playSound('pig');
    setMessage(`${pig.id.includes('top') ? 'Top shelf!' : 'Direct hit!'} The moon-pig dropped the snacks.`);
  }

  function resolveProjectileCollisions(projectile) {
    for (const block of state.blocks) {
      if (!block.active) continue;
      const resolved = core.resolveCircleRectCollision(projectile, block, block.material === 'stone' ? 0.28 : 0.42);
      if (!resolved.collided) continue;
      Object.assign(projectile, resolved);
      const speed = resolved.impactSpeed || Math.hypot(projectile.vx, projectile.vy);
      if (speed > 22 && !projectile.hitIds.has(block.id)) {
        projectile.hitIds.add(block.id);
        damageBlock(block, speed, projectile);
      }
    }

    for (const pig of [...state.pigs]) {
      const contact = core.circleCircleCollision(projectile, pig);
      if (!contact.hit || projectile.hitIds.has(pig.id)) continue;
      const speed = Math.hypot(projectile.vx, projectile.vy);
      if (speed < 28) continue;
      projectile.hitIds.add(pig.id);
      projectile.vx *= 0.48;
      projectile.vy *= 0.48;
      defeatPig(pig, projectile);
    }
  }

  function launchBird() {
    const bird = state.currentBird;
    if (!bird) return;
    const pull = core.distance(bird, SLING);
    if (pull < 12) {
      bird.x = SLING.x;
      bird.y = SLING.y;
      state.dragging = false;
      return;
    }
    bird.vx = (SLING.x - bird.x) * 5.55;
    bird.vy = (SLING.y - bird.y) * 5.55;
    bird.life = 0;
    bird.rotation = 0;
    bird.inFlight = true;
    state.queueIndex += 1;
    state.currentBird = null;
    state.projectiles = [bird];
    state.dragging = false;
    setPhase('flight');
    setMessage('In the air! Tap the ability button for a little extra mischief.');
    spawnBurst(bird.x, bird.y, [BIRD_TYPES[bird.type].color, '#fff4d6'], 9, 100);
    playSound('launch');
    updateHud();
  }

  function useAbility() {
    if (state.phase !== 'flight') return;
    const bird = state.projectiles.find((projectile) => !projectile.mini) || state.projectiles[0];
    if (!bird || bird.abilityUsed) return;
    bird.abilityUsed = true;
    if (bird.type === 'blue') {
      const speed = Math.max(250, Math.hypot(bird.vx, bird.vy));
      const angle = Math.atan2(bird.vy, bird.vx);
      bird.vx *= 0.62;
      bird.vy *= 0.62;
      [-1, 1].forEach((direction) => {
        const splitAngle = angle + direction * 0.44;
        const mini = createBird('blue', true);
        mini.x = bird.x;
        mini.y = bird.y;
        mini.vx = Math.cos(splitAngle) * speed * 0.92;
        mini.vy = Math.sin(splitAngle) * speed * 0.92;
        mini.life = bird.life;
        state.projectiles.push(mini);
      });
      setMessage('Split shot! Two tiny troublemakers incoming.');
      spawnBurst(bird.x, bird.y, ['#66cbed', '#fff4d6'], 16, 170);
    } else if (bird.type === 'yellow') {
      bird.vx *= 1.32;
      bird.vy = Math.abs(bird.vy) * 0.55 + 160;
      setMessage('Dive bomb! The Lemon bird found the weak spot.');
      spawnBurst(bird.x, bird.y, ['#ffd166', '#ff6b5b', '#fff4d6'], 17, 180);
    } else {
      bird.vx *= 1.34;
      bird.vy *= 1.18;
      setMessage('Rage boost! Crimson is bringing the thunder.');
      spawnBurst(bird.x, bird.y, ['#ff6b5b', '#ffd166', '#fff4d6'], 15, 185);
    }
    playSound('ability');
    updateAbilityUi();
  }

  function prepareNextBird() {
    if (state.pigs.length === 0) return;
    if (state.queueIndex >= activeLevel().birds.length) {
      finishLost();
      return;
    }
    state.currentBird = createBird(activeLevel().birds[state.queueIndex]);
    setPhase('ready');
    setMessage(`Bird ${state.queueIndex + 1} is ready. Pull back and choose your angle.`);
    updateHud();
  }

  function finishWin() {
    if (state.phase === 'won') return;
    state.projectiles = [];
    const birdsLeft = activeLevel().birds.length - state.queueIndex;
    const starsEarned = birdsLeft >= 2 ? 3 : birdsLeft === 1 ? 2 : 1;
    setPhase('won');
    spawnBurst(845, 300, ['#ffd166', '#65e6b2', '#fff4d6', '#ff6b5b'], 38, 260);
    playSound('win');
    const nextText = state.levelIndex < LEVELS.length - 1 ? 'Next level' : 'Play again';
    showPanel('Moon-pigs cleared', `${'★'.repeat(starsEarned)}${'☆'.repeat(3 - starsEarned)}`, `You cleared ${activeLevel().title} with ${state.levelScore.toLocaleString()} points this round. The snack stash is yours.`, nextText);
    setMessage(`Level clear! ${starsEarned} star${starsEarned === 1 ? '' : 's'} earned.`);
    updateHud();
  }

  function finishLost() {
    if (state.phase === 'lost') return;
    setPhase('lost');
    showPanel('The tower held', 'That was a wobble', `${state.pigs.length} moon-pig${state.pigs.length === 1 ? '' : 's'} still have snacks. Try a different angle or save the special move for the impact.`, 'Retry level');
    setMessage('No birds left. The moon-pigs are celebrating quietly.');
    updateHud();
  }

  function updateProjectiles(deltaTime) {
    for (const projectile of state.projectiles) {
      projectile.life += deltaTime;
      const beforeBounce = projectile.y;
      const stepped = core.stepProjectile(projectile, deltaTime, WORLD.groundY, {
        gravity: WORLD.gravity,
        restitution: projectile.mini ? 0.36 : 0.42,
        groundFriction: 0.76,
        bounds: { left: -50, right: WORLD.width + 50 },
      });
      Object.assign(projectile, stepped);
      projectile.rotation = Math.atan2(projectile.vy, projectile.vx) * 0.14;
      resolveProjectileCollisions(projectile);
      if (stepped.bounced && beforeBounce < WORLD.groundY - projectile.radius + 3) {
        spawnBurst(projectile.x, WORLD.groundY - 2, ['#b9c8b5', '#fff4d6'], 5, 55);
      }
      const speed = Math.hypot(projectile.vx, projectile.vy);
      projectile.settled = projectile.life > 0.65 && projectile.y > WORLD.groundY - 82 && speed < 72;
    }

    state.projectiles = state.projectiles.filter((projectile) => (
      !projectile.settled
      && projectile.life < 8.5
      && projectile.x > -130
      && projectile.x < WORLD.width + 130
      && projectile.y < WORLD.height + 110
    ));

    if (state.pigs.length === 0) {
      finishWin();
    } else if (state.projectiles.length === 0) {
      if (state.nextBirdAt === 0) {
        state.nextBirdAt = performance.now() + 650;
        setPhase('settle');
        setMessage('The dust is settling...');
      } else if (performance.now() >= state.nextBirdAt) {
        state.nextBirdAt = 0;
        prepareNextBird();
      }
    }
  }

  function updateEffects(deltaTime) {
    state.particles = state.particles.filter((particle) => {
      particle.life -= deltaTime;
      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;
      particle.vy += particle.gravity * deltaTime;
      particle.vx *= 0.985;
      return particle.life > 0;
    });
    state.popups = state.popups.filter((popup) => {
      popup.life -= deltaTime;
      popup.y -= 24 * deltaTime;
      return popup.life > 0;
    });
    state.blocks.forEach((block) => {
      block.flash = Math.max(0, block.flash - deltaTime);
      block.shake = Math.max(0, block.shake - deltaTime * 2.4);
    });
  }

  function update(deltaTime) {
    updateEffects(deltaTime);
    if (state.phase === 'flight') updateProjectiles(deltaTime);
  }

  function resizeCanvas() {
    const bounds = canvas.getBoundingClientRect();
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderScale = bounds.width / WORLD.width;
    canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
  }

  function beginWorldDraw() {
    context.setTransform(renderScale * pixelRatio, 0, 0, renderScale * pixelRatio, 0, 0);
    context.clearRect(0, 0, WORLD.width, WORLD.height);
    context.lineJoin = 'round';
    context.lineCap = 'round';
  }

  function pathRoundRect(x, y, width, height, radius) {
    context.beginPath();
    if (typeof context.roundRect === 'function') {
      context.roundRect(x, y, width, height, radius);
      return;
    }
    const r = Math.min(radius, width / 2, height / 2);
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function fillRoundRect(x, y, width, height, radius, fill, stroke = null) {
    pathRoundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    if (stroke) {
      context.strokeStyle = stroke;
      context.lineWidth = 2;
      context.stroke();
    }
  }

  function drawBackground(time) {
    const sky = context.createLinearGradient(0, 0, 0, WORLD.groundY);
    sky.addColorStop(0, '#121632');
    sky.addColorStop(0.56, '#2f2a58');
    sky.addColorStop(1, '#65416b');
    context.fillStyle = sky;
    context.fillRect(0, 0, WORLD.width, WORLD.height);

    context.save();
    context.globalAlpha = 0.08;
    context.fillStyle = '#ff6b5b';
    context.beginPath();
    context.arc(900, 90, 170, 0, Math.PI * 2);
    context.fill();
    context.restore();

    stars.forEach((star) => {
      const twinkle = reducedMotion ? 0.76 : 0.54 + Math.sin(time * 2.1 + star.twinkle) * 0.22;
      context.globalAlpha = twinkle;
      context.fillStyle = star.size > 1.8 ? '#fff4d6' : '#b9dff0';
      context.beginPath();
      context.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      context.fill();
    });
    context.globalAlpha = 1;

    context.save();
    context.shadowColor = 'rgba(255, 209, 102, 0.35)';
    context.shadowBlur = 28;
    context.fillStyle = '#ffd166';
    context.beginPath();
    context.arc(1000, 96, 47, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    context.fillStyle = 'rgba(182, 115, 89, 0.22)';
    [[982, 76, 9], [1015, 111, 7], [990, 117, 4]].forEach(([x, y, radius]) => {
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    });
    context.restore();

    context.fillStyle = '#171b3a';
    context.beginPath();
    context.moveTo(0, 436);
    context.quadraticCurveTo(125, 362, 270, 434);
    context.quadraticCurveTo(420, 354, 565, 435);
    context.quadraticCurveTo(715, 345, 872, 432);
    context.quadraticCurveTo(1020, 366, 1200, 426);
    context.lineTo(1200, WORLD.groundY);
    context.lineTo(0, WORLD.groundY);
    context.closePath();
    context.fill();

    context.fillStyle = 'rgba(101, 230, 178, 0.09)';
    context.beginPath();
    context.moveTo(0, 475);
    context.quadraticCurveTo(160, 420, 320, 478);
    context.quadraticCurveTo(500, 410, 660, 480);
    context.quadraticCurveTo(810, 424, 970, 480);
    context.quadraticCurveTo(1090, 440, 1200, 477);
    context.lineTo(1200, WORLD.groundY);
    context.lineTo(0, WORLD.groundY);
    context.closePath();
    context.fill();

    context.fillStyle = '#344c64';
    context.fillRect(0, WORLD.groundY, WORLD.width, WORLD.height - WORLD.groundY);
    context.fillStyle = '#65e6b2';
    context.fillRect(0, WORLD.groundY, WORLD.width, 7);
    context.fillStyle = 'rgba(255, 244, 214, 0.08)';
    for (let stripe = 0; stripe < WORLD.width; stripe += 64) {
      context.fillRect(stripe, WORLD.groundY + 27 + (stripe % 3) * 10, 38, 3);
    }

    context.fillStyle = 'rgba(255, 244, 214, 0.22)';
    for (let tuft = 0; tuft < 58; tuft += 1) {
      const x = (tuft * 97) % WORLD.width;
      context.beginPath();
      context.moveTo(x, WORLD.groundY + 4);
      context.lineTo(x + 4, WORLD.groundY - 6 - (tuft % 3) * 2);
      context.lineTo(x + 8, WORLD.groundY + 4);
      context.fill();
    }
  }

  function drawAimGuide() {
    if (!state.dragging || !state.currentBird) return;
    const bird = state.currentBird;
    const velocity = { x: (SLING.x - bird.x) * 5.55, y: (SLING.y - bird.y) * 5.55 };
    context.save();
    for (let step = 1; step <= 15; step += 1) {
      const t = step * 0.085;
      const x = bird.x + velocity.x * t;
      const y = bird.y + velocity.y * t + 0.5 * WORLD.gravity * t * t;
      if (y > WORLD.groundY) break;
      context.globalAlpha = 0.72 - step * 0.035;
      context.fillStyle = step % 3 === 0 ? '#ffd166' : '#fff4d6';
      context.beginPath();
      context.arc(x, y, Math.max(2, 6 - step * 0.2), 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  function drawSlingshot() {
    context.save();
    context.strokeStyle = '#8a513d';
    context.lineWidth = 14;
    context.beginPath();
    context.moveTo(SLING.x - 14, WORLD.groundY + 9);
    context.lineTo(SLING.x - 11, SLING.y - 50);
    context.moveTo(SLING.x + 18, WORLD.groundY + 9);
    context.lineTo(SLING.x + 12, SLING.y - 50);
    context.stroke();
    context.strokeStyle = '#c2784e';
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(SLING.x - 12, SLING.y - 48);
    context.lineTo(SLING.x - 18, SLING.y - 76);
    context.moveTo(SLING.x + 12, SLING.y - 48);
    context.lineTo(SLING.x + 18, SLING.y - 76);
    context.stroke();
    context.fillStyle = '#6d3f3b';
    context.beginPath();
    context.ellipse(SLING.x + 2, WORLD.groundY + 6, 32, 8, 0, 0, Math.PI * 2);
    context.fill();
    if (state.currentBird) {
      context.strokeStyle = '#ffd166';
      context.lineWidth = 5;
      context.beginPath();
      context.moveTo(SLING.x - 17, SLING.y - 73);
      context.lineTo(state.currentBird.x, state.currentBird.y);
      context.lineTo(SLING.x + 17, SLING.y - 73);
      context.stroke();
    }
    context.restore();
  }

  function drawBlock(block, time) {
    if (!block.active) return;
    const wobble = block.shake > 0 ? Math.sin(time * 34 + block.crackSeed) * block.shake * 2.2 : 0;
    context.save();
    context.translate(block.x + block.width / 2 + wobble, block.y + block.height / 2);
    const angle = block.shake > 0 ? Math.sin(time * 20 + block.crackSeed) * block.shake * 0.025 : 0;
    context.rotate(angle);
    const x = -block.width / 2;
    const y = -block.height / 2;
    if (block.material === 'glass') {
      fillRoundRect(x, y, block.width, block.height, 5, 'rgba(126, 218, 231, 0.66)', '#d1f6f5');
      context.save();
      context.globalAlpha = 0.56;
      context.strokeStyle = '#fff4d6';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + 5, y + block.height - 5);
      context.lineTo(x + block.width - 5, y + 5);
      context.moveTo(x + block.width * 0.35, y + block.height);
      context.lineTo(x + block.width, y + block.height * 0.35);
      context.stroke();
      context.restore();
    } else if (block.material === 'stone') {
      fillRoundRect(x, y, block.width, block.height, 5, '#766d87', '#b1a3bd');
      context.strokeStyle = 'rgba(255, 244, 214, 0.25)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + 5, y + block.height * 0.28);
      context.lineTo(x + block.width - 5, y + block.height * 0.28);
      context.moveTo(x + block.width * 0.28, y + 2);
      context.lineTo(x + block.width * 0.28, y + block.height - 2);
      context.stroke();
    } else {
      fillRoundRect(x, y, block.width, block.height, 5, '#b96c47', '#f0a260');
      context.strokeStyle = 'rgba(102, 42, 45, 0.56)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + block.width * 0.32, y + 4);
      context.lineTo(x + block.width * 0.32, y + block.height - 4);
      context.moveTo(x + block.width * 0.68, y + 4);
      context.lineTo(x + block.width * 0.68, y + block.height - 4);
      context.stroke();
      context.fillStyle = '#ffd166';
      [[x + 7, y + 7], [x + block.width - 7, y + 7], [x + 7, y + block.height - 7], [x + block.width - 7, y + block.height - 7]].forEach(([boltX, boltY]) => {
        context.beginPath();
        context.arc(boltX, boltY, 2.2, 0, Math.PI * 2);
        context.fill();
      });
    }
    if (block.hp < block.maxHp * 0.58) {
      context.strokeStyle = 'rgba(38, 23, 49, 0.72)';
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x + block.width * 0.22, y + block.height * 0.28);
      context.lineTo(x + block.width * 0.5, y + block.height * 0.46);
      context.lineTo(x + block.width * 0.35, y + block.height * 0.72);
      context.moveTo(x + block.width * 0.5, y + block.height * 0.46);
      context.lineTo(x + block.width * 0.79, y + block.height * 0.2);
      context.stroke();
    }
    if (block.flash > 0) {
      context.globalAlpha = block.flash * 1.8;
      fillRoundRect(x, y, block.width, block.height, 5, '#fff4d6');
    }
    context.restore();
  }

  function drawPig(pig, time) {
    if (!pig.alive) return;
    const bob = reducedMotion ? 0 : Math.sin(time * 3.5 + pig.phase) * 1.6;
    const y = pig.y + bob;
    context.save();
    context.translate(pig.x, y);
    context.fillStyle = 'rgba(10, 13, 30, 0.24)';
    context.beginPath();
    context.ellipse(0, pig.radius + 7, pig.radius * 0.85, 5, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#65e6b2';
    context.strokeStyle = '#215f5b';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(-pig.radius * 0.68, -pig.radius * 0.58);
    context.lineTo(-pig.radius * 0.82, -pig.radius * 1.03);
    context.lineTo(-pig.radius * 0.35, -pig.radius * 0.78);
    context.closePath();
    context.fill();
    context.stroke();
    context.beginPath();
    context.moveTo(pig.radius * 0.68, -pig.radius * 0.58);
    context.lineTo(pig.radius * 0.82, -pig.radius * 1.03);
    context.lineTo(pig.radius * 0.35, -pig.radius * 0.78);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = '#65e6b2';
    context.beginPath();
    context.arc(0, 0, pig.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#fff4d6';
    [[-pig.radius * 0.36, -pig.radius * 0.22], [pig.radius * 0.36, -pig.radius * 0.22]].forEach(([eyeX, eyeY]) => {
      context.beginPath();
      context.arc(eyeX, eyeY, pig.radius * 0.26, 0, Math.PI * 2);
      context.fill();
    });
    context.fillStyle = '#10152d';
    [[-pig.radius * 0.29, -pig.radius * 0.19], [pig.radius * 0.4, -pig.radius * 0.19]].forEach(([pupilX, pupilY]) => {
      context.beginPath();
      context.arc(pupilX, pupilY, pig.radius * 0.1, 0, Math.PI * 2);
      context.fill();
    });
    context.fillStyle = '#4cbb93';
    context.beginPath();
    context.ellipse(0, pig.radius * 0.35, pig.radius * 0.43, pig.radius * 0.25, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#173d46';
    [-pig.radius * 0.15, pig.radius * 0.15].forEach((noseX) => {
      context.beginPath();
      context.arc(noseX, pig.radius * 0.35, pig.radius * 0.06, 0, Math.PI * 2);
      context.fill();
    });
    context.strokeStyle = '#215f5b';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(0, pig.radius * 0.19, pig.radius * 0.25, 0.25, Math.PI - 0.25);
    context.stroke();
    context.restore();
  }

  function drawBird(bird) {
    const info = BIRD_TYPES[bird.type];
    context.save();
    context.translate(bird.x, bird.y);
    context.rotate(bird.rotation || 0);
    context.fillStyle = 'rgba(10, 13, 30, 0.24)';
    context.beginPath();
    context.ellipse(0, bird.radius + 5, bird.radius * 0.8, 4, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = info.color;
    context.strokeStyle = info.shade;
    context.lineWidth = 3;
    context.beginPath();
    context.arc(0, 0, bird.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = info.shade;
    context.beginPath();
    context.ellipse(-bird.radius * 0.34, bird.radius * 0.2, bird.radius * 0.3, bird.radius * 0.5, -0.45, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#fff4d6';
    context.beginPath();
    context.ellipse(bird.radius * 0.1, bird.radius * 0.22, bird.radius * 0.54, bird.radius * 0.39, 0.1, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#fff4d6';
    context.beginPath();
    context.arc(-bird.radius * 0.29, -bird.radius * 0.23, bird.radius * 0.28, 0, Math.PI * 2);
    context.arc(bird.radius * 0.26, -bird.radius * 0.23, bird.radius * 0.28, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#10152d';
    context.beginPath();
    context.arc(-bird.radius * 0.19, -bird.radius * 0.19, bird.radius * 0.1, 0, Math.PI * 2);
    context.arc(bird.radius * 0.35, -bird.radius * 0.19, bird.radius * 0.1, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#ffb24f';
    context.strokeStyle = '#8a453e';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(bird.radius * 0.55, -bird.radius * 0.02);
    context.lineTo(bird.radius * 1.16, bird.radius * 0.15);
    context.lineTo(bird.radius * 0.55, bird.radius * 0.3);
    context.closePath();
    context.fill();
    context.stroke();
    context.strokeStyle = '#10152d';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(-bird.radius * 0.52, -bird.radius * 0.55);
    context.lineTo(-bird.radius * 0.03, -bird.radius * 0.43);
    context.moveTo(bird.radius * 0.08, -bird.radius * 0.44);
    context.lineTo(bird.radius * 0.55, -bird.radius * 0.58);
    context.stroke();
    context.fillStyle = info.color;
    context.beginPath();
    context.moveTo(-bird.radius * 0.34, -bird.radius * 0.75);
    context.lineTo(-bird.radius * 0.08, -bird.radius * 1.18);
    context.lineTo(bird.radius * 0.08, -bird.radius * 0.74);
    context.closePath();
    context.fill();
    if (bird.type === 'blue') {
      context.beginPath();
      context.moveTo(bird.radius * 0.12, -bird.radius * 0.75);
      context.lineTo(bird.radius * 0.36, -bird.radius * 1.1);
      context.lineTo(bird.radius * 0.46, -bird.radius * 0.62);
      context.closePath();
      context.fill();
    }
    context.restore();
  }

  function drawParticles() {
    state.particles.forEach((particle) => {
      context.save();
      context.globalAlpha = Math.min(1, particle.life / 0.35);
      context.translate(particle.x, particle.y);
      if (particle.shape === 0) {
        context.fillStyle = particle.color;
        context.beginPath();
        context.arc(0, 0, particle.size, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillStyle = particle.color;
        context.rotate(particle.x * 0.02 + particle.y * 0.01);
        context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size);
      }
      context.restore();
    });
  }

  function drawPopups() {
    state.popups.forEach((popup) => {
      context.save();
      context.globalAlpha = Math.min(1, popup.life * 1.6);
      context.fillStyle = popup.color;
      context.font = '900 19px Impact, Arial Black, sans-serif';
      context.textAlign = 'center';
      context.strokeStyle = 'rgba(16, 21, 45, 0.7)';
      context.lineWidth = 4;
      context.strokeText(popup.text, popup.x, popup.y);
      context.fillText(popup.text, popup.x, popup.y);
      context.restore();
    });
  }

  function drawReadyHint() {
    if (state.phase !== 'ready' || state.dragging) return;
    context.save();
    context.globalAlpha = 0.72;
    context.fillStyle = '#fff4d6';
    context.font = '700 15px Trebuchet MS, sans-serif';
    context.textAlign = 'center';
    context.fillText('drag me', SLING.x, SLING.y - 115);
    context.strokeStyle = '#ffd166';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(SLING.x, SLING.y - 106);
    context.lineTo(SLING.x, SLING.y - 82);
    context.stroke();
    context.beginPath();
    context.moveTo(SLING.x, SLING.y - 82);
    context.lineTo(SLING.x - 5, SLING.y - 91);
    context.moveTo(SLING.x, SLING.y - 82);
    context.lineTo(SLING.x + 5, SLING.y - 91);
    context.stroke();
    context.restore();
  }

  function drawScene(time) {
    beginWorldDraw();
    drawBackground(time);
    drawAimGuide();
    state.blocks.forEach((block) => drawBlock(block, time));
    state.pigs.forEach((pig) => drawPig(pig, time));
    drawSlingshot();
    if (state.currentBird) drawBird(state.currentBird);
    state.projectiles.forEach((projectile) => drawBird(projectile));
    drawReadyHint();
    drawParticles();
    drawPopups();
  }

  function toWorldPosition(event) {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * WORLD.width,
      y: ((event.clientY - bounds.top) / bounds.height) * WORLD.height,
    };
  }

  function updateDrag(position) {
    if (!state.currentBird) return;
    const offset = { x: position.x - SLING.x, y: position.y - SLING.y };
    const length = Math.hypot(offset.x, offset.y);
    const scale = length > SLING.maxPull ? SLING.maxPull / length : 1;
    state.currentBird.x = SLING.x + offset.x * scale;
    state.currentBird.y = SLING.y + offset.y * scale;
  }

  function onPointerDown(event) {
    if (event.button !== 0 || state.phase !== 'ready' || !state.currentBird) return;
    const position = toWorldPosition(event);
    if (core.distance(position, state.currentBird) > 54 && core.distance(position, SLING) > 54) return;
    state.dragging = true;
    state.pointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    canvas.focus({ preventScroll: true });
    updateDrag(position);
    ensureAudio();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    updateDrag(toWorldPosition(event));
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    state.pointerId = null;
    launchBird();
    event.preventDefault();
  }

  function startOrContinue() {
    ensureAudio();
    if (state.phase === 'intro') {
      state.started = true;
      loadLevel(0);
      return;
    }
    if (state.phase === 'won') {
      if (state.levelIndex < LEVELS.length - 1) {
        state.levelIndex += 1;
        loadLevel(state.levelIndex);
      } else {
        state.score = 0;
        state.started = true;
        loadLevel(0);
      }
      return;
    }
    if (state.phase === 'lost') {
      state.started = true;
      loadLevel(state.levelIndex);
    }
  }

  function restartLevel() {
    ensureAudio();
    state.started = true;
    loadLevel(state.levelIndex);
    setMessage(`Restarted ${activeLevel().title}. Find the clean angle.`);
  }

  function toggleMute() {
    state.muted = !state.muted;
    try {
      localStorage.setItem(soundStorageKey, String(state.muted));
    } catch {
      // The game remains playable when storage is unavailable in a locked-down file context.
    }
    updateHud();
    setMessage(state.muted ? 'Sound muted. The moon-pigs cannot hear you plotting.' : 'Sound on. Make some noise.');
    if (!state.muted) playSound('ability');
  }

  function frame(now) {
    const deltaTime = Math.min(0.035, Math.max(0, (now - state.lastFrame) / 1000));
    state.lastFrame = now;
    update(deltaTime);
    drawScene(now / 1000);
    requestAnimationFrame(frame);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  refs.startButton.addEventListener('click', startOrContinue);
  refs.resetButton.addEventListener('click', restartLevel);
  refs.muteButton.addEventListener('click', toggleMute);
  refs.abilityButton.addEventListener('click', useAbility);
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.code === 'Space') {
      if (state.phase === 'flight') {
        event.preventDefault();
        useAbility();
      }
    } else if (event.key.toLowerCase() === 'r') {
      restartLevel();
    } else if (event.key === 'Enter' && state.phase !== 'ready' && state.phase !== 'flight' && state.phase !== 'settle') {
      startOrContinue();
    }
  });

  loadLevel(0);
  resizeCanvas();
  requestAnimationFrame(frame);
})();
