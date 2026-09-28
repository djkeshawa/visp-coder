(() => {
  'use strict';

  const W = 960, H = 540, GROUND = 500;
  const SLING = { x: 146, y: 390 };
  const RADIUS = 17, MAX_PULL = 120, MAX_SPEED = 690, GRAVITY = 760;
  const STEP = 1 / 60;
  const game = document.querySelector('#game');
  const canvas = document.querySelector('#scene');
  const ctx = canvas.getContext('2d');
  const ui = {
    level: document.querySelector('#level'), score: document.querySelector('#score'),
    birds: document.querySelector('#birds'), hint: document.querySelector('#hint'),
    endcard: document.querySelector('#endcard'), endtitle: document.querySelector('#endtitle'),
    endsubtitle: document.querySelector('#endsubtitle'), continue: document.querySelector('#continue')
  };
  const levels = [
    [
      ['pig', 635, 478, 22], ['pig', 750, 478, 22],
      ['block', 688, 476, 27, 48], ['block', 689, 443, 94, 15]
    ],
    [
      ['pig', 610, 478, 22], ['pig', 785, 478, 22], ['pig', 706, 399, 22],
      ['block', 654, 461, 20, 78], ['block', 758, 461, 20, 78],
      ['block', 706, 415, 128, 16]
    ],
    [
      ['pig', 592, 478, 22], ['pig', 716, 478, 22], ['pig', 824, 478, 22],
      ['block', 650, 467, 28, 66], ['block', 770, 467, 28, 66],
      ['block', 710, 426, 155, 16], ['block', 710, 391, 26, 55]
    ]
  ];
  let level = 1, score = 0, birds = 3, state = 'aiming';
  let bird, bodies = [], particles = [], trail = [], dragging = false;
  let elapsed = 0, stillFor = 0, paused = false, lastFrame = 0, accumulator = 0;

  function makeBody(row) {
    const [kind, x, y, w, h = w] = row;
    return { kind, x, y, w, h, vx: 0, vy: 0, hp: kind === 'pig' ? 62 : 105, hitFlash: 0 };
  }

  function sync() {
    const pigs = bodies.filter(b => b.kind === 'pig').length;
    Object.assign(game.dataset, { state, level, score, birds, pigs });
    ui.level.textContent = level;
    ui.score.textContent = score.toLocaleString();
    ui.birds.textContent = birds;
    ui.hint.textContent = state === 'aiming' ? 'Drag the bird back and release' : state === 'flying' ? 'Watch it fly!' : '';
    ui.endcard.hidden = state !== 'won' && state !== 'lost';
    if (state === 'won') {
      ui.endtitle.textContent = 'Level cleared!';
      ui.endsubtitle.textContent = `${score.toLocaleString()} points · Nice shot!`;
      ui.continue.textContent = level === 3 ? 'Play again' : 'Next level';
    } else if (state === 'lost') {
      ui.endtitle.textContent = 'Try again!';
      ui.endsubtitle.textContent = 'The pigs are still standing.';
      ui.continue.textContent = 'Retry';
    }
  }

  function restart(nextLevel = level) {
    level = Math.max(1, Math.min(3, Math.round(Number(nextLevel) || 1)));
    score = 0;
    birds = 3;
    state = 'aiming';
    bodies = levels[level - 1].map(makeBody);
    bird = { x: SLING.x, y: SLING.y, vx: 0, vy: 0, hp: 110 };
    particles = [];
    trail = [];
    dragging = false;
    elapsed = stillFor = accumulator = 0;
    sync();
    render();
  }

  function launchVector(vx, vy) {
    if (state !== 'aiming' || !bird) return;
    bird.x = SLING.x;
    bird.y = SLING.y;
    bird.vx = vx;
    bird.vy = vy;
    birds--;
    state = 'flying';
    elapsed = stillFor = 0;
    trail = [];
    sync();
    render();
  }

  function launch(angleDegrees, power) {
    const radians = Number(angleDegrees) * Math.PI / 180;
    const speed = MAX_SPEED * Math.max(0, Math.min(1, Number(power) || 0));
    launchVector(Math.cos(radians) * speed, -Math.sin(radians) * speed);
  }

  function burst(x, y, color) {
    for (let i = 0; i < 15; i++) {
      const a = i * Math.PI * 2 / 15;
      const v = 65 + (i % 4) * 29;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 45,
        life: .6, color, size: i % 3 === 0 ? 6 : 3 });
    }
  }

  function damage(body, amount) {
    if (body.hp <= 0) return;
    body.hp -= amount;
    body.hitFlash = .15;
    if (body.hp <= 0) {
      bodies.splice(bodies.indexOf(body), 1);
      score += body.kind === 'pig' ? 5000 : 500;
      burst(body.x, body.y, body.kind === 'pig' ? '#93c744' : '#e3b56c');
      if (!bodies.some(b => b.kind === 'pig')) state = 'won';
      sync();
    }
  }

  function birdHit(body) {
    const left = body.x - body.w / 2, right = body.x + body.w / 2;
    const top = body.y - body.h / 2, bottom = body.y + body.h / 2;
    const cx = Math.max(left, Math.min(bird.x, right));
    const cy = Math.max(top, Math.min(bird.y, bottom));
    const dx = bird.x - cx, dy = bird.y - cy;
    if (dx * dx + dy * dy >= RADIUS * RADIUS) return;
    let nx = dx, ny = dy, distance = Math.hypot(dx, dy);
    if (distance < .001) {
      nx = bird.x < body.x ? -1 : 1;
      ny = 0;
      distance = 1;
    }
    nx /= distance; ny /= distance;
    const relative = Math.hypot(bird.vx - body.vx, bird.vy - body.vy);
    if (relative > 45) {
      damage(body, relative * .17);
      bird.hp -= relative * .11;
      body.vx += bird.vx * .3;
      body.vy += bird.vy * .22;
      burst(cx, cy, '#fff0b0');
    }
    bird.x += nx * (RADIUS - distance + .5);
    bird.y += ny * (RADIUS - distance + .5);
    const normalSpeed = bird.vx * nx + bird.vy * ny;
    if (normalSpeed < 0) {
      bird.vx -= normalSpeed * nx * 1.4;
      bird.vy -= normalSpeed * ny * 1.4;
      bird.vx *= .73;
      bird.vy *= .73;
    }
  }

  function settleBodies(dt) {
    for (const body of bodies) {
      body.hitFlash = Math.max(0, body.hitFlash - dt);
      body.vy += GRAVITY * dt;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      const floor = GROUND - body.h / 2;
      if (body.y > floor) {
        body.y = floor;
        body.vy = Math.abs(body.vy) > 70 ? -body.vy * .14 : 0;
        body.vx *= .86;
      }
      body.vx *= .995;
    }
    // A small number of bodies makes pairwise support and collision resolution simple.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        const ox = (a.w + b.w) / 2 - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        if (oy < ox) {
          const upper = a.y < b.y ? a : b;
          const lower = upper === a ? b : a;
          const relative = Math.max(0, upper.vy - lower.vy);
          upper.y -= oy;
          if (relative > 80) {
            damage(upper, relative * .045);
            damage(lower, relative * .045);
          }
          upper.vy = Math.min(upper.vy, lower.vy);
          if (upper.y + upper.h / 2 > GROUND) upper.y = GROUND - upper.h / 2;
        } else {
          const sign = a.x < b.x ? -1 : 1;
          a.x += sign * ox / 2;
          b.x -= sign * ox / 2;
          const relative = Math.abs(a.vx - b.vx);
          if (relative > 80) {
            damage(a, relative * .045);
            damage(b, relative * .045);
          }
          const mean = (a.vx + b.vx) / 2;
          a.vx = b.vx = mean;
        }
      }
    }
  }

  function endTurn() {
    if (state !== 'flying') return;
    if (birds > 0) {
      state = 'aiming';
      bird = { x: SLING.x, y: SLING.y, vx: 0, vy: 0, hp: 110 };
    } else {
      state = 'lost';
      bird = null;
    }
    trail = [];
    sync();
  }

  function tick(dt) {
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
      p.life -= dt;
      p.vy += 260 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (state !== 'flying') return;
    elapsed += dt;
    bird.vy += GRAVITY * dt;
    bird.x += bird.vx * dt;
    bird.y += bird.vy * dt;
    trail.push({ x: bird.x, y: bird.y });
    if (trail.length > 32) trail.shift();
    settleBodies(dt);
    for (const body of [...bodies]) {
      if (state !== 'flying') break;
      birdHit(body);
    }
    if (state === 'won') return;
    if (bird.y > GROUND - RADIUS) {
      bird.y = GROUND - RADIUS;
      bird.vy = Math.abs(bird.vy) > 80 ? -bird.vy * .26 : 0;
      bird.vx *= .72;
    }
    if (bird.y < RADIUS) { bird.y = RADIUS; bird.vy = Math.abs(bird.vy) * .3; }
    if (Math.hypot(bird.vx, bird.vy) < 22 && bird.y >= GROUND - RADIUS - 2) stillFor += dt;
    else stillFor = 0;
    if (bird.x < -RADIUS || bird.x > W + RADIUS || elapsed >= 8 || stillFor > .45) endTurn();
  }

  function step(ms) {
    let remaining = Math.max(0, Math.min(Number(ms) || 0, 60000)) / 1000;
    while (remaining > 1e-9) {
      const dt = Math.min(STEP, remaining);
      tick(dt);
      remaining -= dt;
    }
    render();
  }

  function cloud(x, y, size) {
    ctx.fillStyle = '#ffffffb9';
    for (const [dx, dy, r] of [[0, 0, 20], [23, -11, 26], [50, 0, 18], [20, 7, 23]]) {
      ctx.beginPath(); ctx.arc(x + dx * size, y + dy * size, r * size, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBackdrop() {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#79bfe1'); sky.addColorStop(1, '#c7edf2');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff4b8'; ctx.beginPath(); ctx.arc(840, 115, 49, 0, Math.PI * 2); ctx.fill();
    cloud(220, 122, 1.2); cloud(490, 87, .8); cloud(735, 180, .65);
    ctx.fillStyle = '#80bd9b';
    ctx.beginPath(); ctx.moveTo(0, 440); ctx.quadraticCurveTo(160, 368, 330, 452);
    ctx.quadraticCurveTo(520, 380, 690, 452); ctx.quadraticCurveTo(840, 380, 960, 450);
    ctx.lineTo(960, 500); ctx.lineTo(0, 500); ctx.fill();
    ctx.fillStyle = '#649e75';
    ctx.beginPath(); ctx.moveTo(0, 466); ctx.quadraticCurveTo(270, 422, 500, 475);
    ctx.quadraticCurveTo(720, 421, 960, 470); ctx.lineTo(960, 500); ctx.lineTo(0, 500); ctx.fill();
    ctx.fillStyle = '#6baf6a'; ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = '#426b45'; ctx.fillRect(0, GROUND, W, 6);
    ctx.fillStyle = '#5a834d';
    for (let x = 10; x < W; x += 27) ctx.fillRect(x, 515 + x % 7, 9, 2);
  }

  function drawSling(back) {
    ctx.lineCap = 'round';
    if (back) {
      ctx.strokeStyle = '#65412f'; ctx.lineWidth = 16;
      ctx.beginPath(); ctx.moveTo(145, 498); ctx.lineTo(136, 378); ctx.stroke();
      ctx.strokeStyle = '#392e30'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(136, 378); ctx.lineTo(bird && state === 'aiming' ? bird.x : 147, bird && state === 'aiming' ? bird.y : 394); ctx.stroke();
    } else {
      ctx.strokeStyle = '#855638'; ctx.lineWidth = 15;
      ctx.beginPath(); ctx.moveTo(145, 495); ctx.lineTo(163, 373); ctx.stroke();
      ctx.strokeStyle = '#352e30'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(163, 373); ctx.lineTo(bird && state === 'aiming' ? bird.x : 147, bird && state === 'aiming' ? bird.y : 394); ctx.stroke();
      ctx.fillStyle = '#c98d53'; ctx.beginPath(); ctx.arc(145, 493, 12, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawBody(body) {
    ctx.save(); ctx.translate(body.x, body.y);
    if (body.kind === 'pig') {
      const r = body.w;
      ctx.fillStyle = body.hitFlash ? '#f6eea1' : '#7dae44';
      ctx.strokeStyle = '#426c31'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8dbe55';
      ctx.beginPath(); ctx.arc(-12, -19, 7, 0, Math.PI * 2); ctx.arc(12, -19, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b4d978'; ctx.beginPath(); ctx.ellipse(0, 7, 12, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3b6230';
      for (const x of [-5, 5]) { ctx.beginPath(); ctx.arc(x, 7, 2, 0, Math.PI * 2); ctx.fill(); }
      for (const x of [-9, 9]) { ctx.beginPath(); ctx.arc(x, -5, 2.5, 0, Math.PI * 2); ctx.fill(); }
    } else {
      ctx.fillStyle = body.hitFlash ? '#ffedb6' : '#ba8151';
      ctx.strokeStyle = '#784f36'; ctx.lineWidth = 3;
      ctx.fillRect(-body.w / 2, -body.h / 2, body.w, body.h);
      ctx.strokeRect(-body.w / 2, -body.h / 2, body.w, body.h);
      ctx.strokeStyle = '#e7b67f'; ctx.lineWidth = 2;
      ctx.strokeRect(-body.w / 2 + 6, -body.h / 2 + 6, body.w - 12, body.h - 12);
    }
    ctx.restore();
  }

  function drawBird() {
    if (!bird) return;
    ctx.save(); ctx.translate(bird.x, bird.y);
    ctx.fillStyle = '#b73e38'; ctx.strokeStyle = '#822f30'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e4a071'; ctx.beginPath(); ctx.arc(12, 3, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(5, -5, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#242b31'; ctx.beginPath(); ctx.arc(7, -5, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#4a2930'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-1, -13); ctx.lineTo(10, -11); ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawBackdrop();
    if (state === 'flying') {
      trail.forEach((point, i) => {
        ctx.fillStyle = `rgba(255,255,255,${.12 + .65 * i / trail.length})`;
        ctx.beginPath(); ctx.arc(point.x, point.y, 2 + 2 * i / trail.length, 0, Math.PI * 2); ctx.fill();
      });
    }
    drawSling(true);
    bodies.forEach(drawBody);
    drawBird();
    drawSling(false);
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / .6);
      ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function pointerPosition(event) {
    const rect = game.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * W / rect.width,
      y: (event.clientY - rect.top) * H / rect.height };
  }

  canvas.addEventListener('pointerdown', event => {
    if (state !== 'aiming' || !bird) return;
    const p = pointerPosition(event);
    if (Math.hypot(p.x - bird.x, p.y - bird.y) > RADIUS + 15) return;
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    if (!dragging || state !== 'aiming') return;
    const p = pointerPosition(event);
    const dx = p.x - SLING.x, dy = p.y - SLING.y;
    const scale = Math.min(1, MAX_PULL / Math.max(1, Math.hypot(dx, dy)));
    bird.x = SLING.x + dx * scale;
    bird.y = SLING.y + dy * scale;
    render();
  });
  function release() {
    if (!dragging || state !== 'aiming') return;
    dragging = false;
    const dx = SLING.x - bird.x, dy = SLING.y - bird.y;
    if (Math.hypot(dx, dy) < 5) { bird.x = SLING.x; bird.y = SLING.y; render(); return; }
    launchVector(dx / MAX_PULL * MAX_SPEED, dy / MAX_PULL * MAX_SPEED);
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  document.querySelector('#restart').addEventListener('click', () => restart(level));
  ui.continue.addEventListener('click', () => restart(state === 'won' ? level % 3 + 1 : level));

  function frame(now) {
    if (!paused) {
      if (lastFrame) {
        accumulator += Math.min((now - lastFrame) / 1000, .1);
        while (accumulator >= STEP) { tick(STEP); accumulator -= STEP; }
        render();
      }
      lastFrame = now;
    }
    requestAnimationFrame(frame);
  }

  window.gameTest = {
    pause() { paused = true; accumulator = 0; lastFrame = 0; },
    step,
    resume() { paused = false; lastFrame = 0; },
    launch,
    restart,
    snapshot() {
      return { state, level, score, birds, pigs: bodies.filter(b => b.kind === 'pig').length,
        bird: bird ? { x: bird.x, y: bird.y, vx: bird.vx, vy: bird.vy } : null,
        bodies: bodies.map(b => ({ kind: b.kind, x: b.x, y: b.y, hp: b.hp })) };
    }
  };
  restart(1);
  requestAnimationFrame(frame);
})();
