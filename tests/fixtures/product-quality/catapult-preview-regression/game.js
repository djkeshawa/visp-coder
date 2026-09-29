(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;

  if (root && root.document) {
    const boot = function () {
      const canvas = root.document.getElementById('game');
      if (!canvas || root.gameTest) return;
      const byId = function (id) { return root.document.getElementById(id); };
      const ammoButtons = {};
      ['stone', 'bomb', 'cluster', 'fire'].forEach(function (kind) {
        ammoButtons[kind] = byId('ammo-' + kind);
      });
      const ui = {
        level: byId('level-value'),
        score: byId('score-value'),
        selected: byId('selected-value'),
        hint: byId('game-hint'),
        restartButton: byId('restart-button'),
        ammoButtons: ammoButtons,
        resultPanel: byId('result-panel'),
        resultTitle: byId('result-title'),
        resultCopy: byId('result-copy'),
        resultButton: byId('result-button')
      };
      const game = api.createGame({
        canvas: canvas,
        ctx: canvas.getContext('2d'),
        ui: ui,
        window: root,
        autoStart: true
      });
      root.gameTest = game.test;
    };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const WIDTH = 1200;
  const HEIGHT = 600;
  const GROUND = 560;
  const SLING_X = 157;
  const SLING_Y = 456;
  const MAX_PULL = 150;
  const MAX_SPEED = 950;
  const GRAVITY = 820;
  const FIXED_STEP = 1 / 60;
  const KINDS = ['stone', 'bomb', 'cluster', 'fire'];
  const MATERIALS = {
    wood: { hp: 72, score: 100, density: 0.82 },
    stone: { hp: 190, score: 300, density: 1.85 },
    metal: { hp: 330, score: 800, density: 2.55 }
  };
  const PROJECTILE_RADIUS = { stone: 17, bomb: 15, cluster: 15, fragment: 9, fire: 14 };
  const PROJECTILE_COLOR = {
    stone: '#596b7b',
    bomb: '#343742',
    cluster: '#e8a933',
    fragment: '#f0c360',
    fire: '#ff702c'
  };
  const LEVEL_AMMO = [
    null,
    { stone: 2, bomb: 1, cluster: 1, fire: 1 },
    { stone: 3, bomb: 2, cluster: 2, fire: 2 },
    { stone: 3, bomb: 3, cluster: 2, fire: 2 }
  ];

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function makeBody(kind, material, x, y, w, h, hp) {
    const base = material ? MATERIALS[material].hp : hp;
    return {
      kind: kind,
      material: material || null,
      x: x,
      y: y,
      w: w,
      h: h,
      hp: base,
      maxHp: base,
      vx: 0,
      vy: 0,
      onSurface: false,
      burning: false,
      burnTime: 0,
      spreadTime: 0,
      mass: Math.max(0.45, (w * h / 2200) * (material ? MATERIALS[material].density : 0.5))
    };
  }

  function levelBodies(level) {
    const b = [];
    const add = function (material, x, bottom, w, h) {
      b.push(makeBody('block', material, x, bottom - h / 2, w, h));
    };
    const target = function (x, bottom) {
      b.push(makeBody('target', null, x, bottom - 34 / 2, 25, 34, 26));
    };
    if (level === 1) {
      add('stone', 850, GROUND, 190, 30);
      add('wood', 785, GROUND - 30, 24, 100);
      add('wood', 915, GROUND - 30, 24, 100);
      add('wood', 850, GROUND - 130, 154, 24);
      target(850, GROUND - 30);
      target(850, GROUND - 154);
      add('stone', 1030, GROUND, 70, 30);
    } else if (level === 2) {
      add('stone', 766, GROUND, 150, 30);
      add('metal', 977, GROUND, 150, 30);
      add('stone', 716, GROUND - 30, 25, 100);
      add('wood', 816, GROUND - 30, 25, 100);
      add('wood', 766, GROUND - 130, 126, 24);
      target(766, GROUND - 154);
      add('metal', 927, GROUND - 30, 24, 86);
      add('stone', 1027, GROUND - 30, 24, 86);
      add('metal', 977, GROUND - 116, 126, 24);
      target(977, GROUND - 140);
    } else {
      add('metal', 778, GROUND, 164, 30);
      add('stone', 1012, GROUND, 164, 30);
      add('metal', 718, GROUND - 30, 24, 100);
      add('stone', 838, GROUND - 30, 30, 100);
      add('metal', 778, GROUND - 130, 144, 24);
      target(778, GROUND - 154);
      add('stone', 952, GROUND - 30, 27, 116);
      add('metal', 1072, GROUND - 30, 27, 116);
      add('stone', 1012, GROUND - 146, 144, 24);
      target(1012, GROUND - 170);
    }
    return b;
  }

  function createGame(options) {
    options = options || {};
    const canvas = options.canvas;
    const ctx = options.ctx || (canvas && canvas.getContext ? canvas.getContext('2d') : null);
    const ui = options.ui || {};
    const clock = options.window || (typeof window !== 'undefined' ? window : {});
    const requestFrame = options.requestFrame || (clock.requestAnimationFrame ? clock.requestAnimationFrame.bind(clock) : function () { return 0; });
    const cancelFrame = options.cancelFrame || (clock.cancelAnimationFrame ? clock.cancelAnimationFrame.bind(clock) : function () {});
    const ammoButtons = ui.ammoButtons || {};
    const game = {
      state: 'aiming',
      level: 1,
      score: 0,
      selected: 'stone',
      ammo: Object.assign({}, LEVEL_AMMO[1]),
      bodies: [],
      projectiles: [],
      explosions: [],
      particles: [],
      feedback: [],
      time: 0,
      shotTime: 0,
      quietTime: 0,
      dragging: false,
      dragPoint: null,
      pointerId: null
    };
    let paused = true;
    let generation = 0;
    let lastFrame = null;
    let accumulator = 0;
    let frameHandle = null;

    if (canvas) {
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
    }

    function setData(name, value) {
      if (!canvas) return;
      if (canvas.dataset) canvas.dataset[name] = String(value);
      if (canvas.setAttribute) canvas.setAttribute('data-' + name.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }), String(value));
    }

    function targetsRemaining() {
      let count = 0;
      for (let i = 0; i < game.bodies.length; i += 1) {
        if (game.bodies[i].kind === 'target') count += 1;
      }
      return count;
    }

    function bodySnapshot(body) {
      return {
        kind: body.kind,
        material: body.material,
        x: body.x,
        y: body.y,
        hp: body.hp,
        burning: !!body.burning
      };
    }

    function projectileSnapshot(p) {
      return { kind: p.kind, x: p.x, y: p.y, vx: p.vx, vy: p.vy };
    }

    function syncUI() {
      setData('state', game.state);
      setData('level', game.level);
      setData('score', game.score);
      setData('ammo', game.selected);
      setData('targets', targetsRemaining());
      if (ui.level) ui.level.textContent = String(game.level);
      if (ui.score) ui.score.textContent = String(game.score);
      if (ui.selected) ui.selected.textContent = game.selected;
      if (ui.hint) {
        if (game.state === 'aiming') ui.hint.textContent = 'Pull the loaded shot back, then release';
        else if (game.state === 'flying') ui.hint.textContent = game.selected === 'cluster' ? 'Tap the world to split the cluster' : 'Watch the structure fall';
        else if (game.state === 'won') ui.hint.textContent = 'All enemy banners cleared';
        else ui.hint.textContent = 'No shots remain — try another angle';
      }
      KINDS.forEach(function (kind) {
        const button = ammoButtons[kind];
        if (!button) return;
        const count = game.ammo[kind] || 0;
        if (button.dataset) button.dataset.count = String(count);
        if (button.setAttribute) {
          button.setAttribute('aria-pressed', String(game.selected === kind));
          button.setAttribute('aria-label', kind.charAt(0).toUpperCase() + kind.slice(1) + ', ' + count + ' rounds');
        }
        if ('disabled' in button) button.disabled = count <= 0 || game.state !== 'aiming';
        if (button.classList) button.classList.toggle('selected', game.selected === kind);
        const countNode = button.querySelector ? button.querySelector('[data-count]') : null;
        if (countNode) countNode.textContent = String(count);
      });
      if (ui.restartButton) ui.restartButton.disabled = false;
      if (ui.resultPanel) ui.resultPanel.hidden = game.state !== 'won' && game.state !== 'lost';
      if (ui.resultTitle) ui.resultTitle.textContent = game.state === 'won' ? 'Victory!' : 'Siege ended';
      if (ui.resultCopy) {
        if (game.state === 'won') {
          ui.resultCopy.textContent = game.level < 3 ? 'The banners are down. Your next fort is waiting.' : 'Every fort has fallen. Play the campaign again?';
        } else {
          ui.resultCopy.textContent = 'Your last shot has landed. Reload the level and plan a new attack.';
        }
      }
      if (ui.resultButton) {
        ui.resultButton.textContent = game.state === 'won' ? (game.level < 3 ? 'Next level' : 'Play again') : 'Retry';
      }
    }

    function markState(next) {
      game.state = next;
      if (next !== 'aiming') {
        game.dragging = false;
        game.dragPoint = null;
      }
      syncUI();
    }

    function loadLevel(level) {
      game.level = clamp(Math.floor(Number(level) || 1), 1, 3);
      game.score = 0;
      game.ammo = Object.assign({}, LEVEL_AMMO[game.level]);
      game.bodies = levelBodies(game.level);
      game.projectiles = [];
      game.explosions = [];
      game.particles = [];
      game.feedback = [];
      game.time = 0;
      game.shotTime = 0;
      game.quietTime = 0;
      game.selected = 'stone';
      game.dragging = false;
      game.dragPoint = null;
      markState('aiming');
      render();
    }

    function nextAvailableKind() {
      if ((game.ammo[game.selected] || 0) > 0) return;
      for (let i = 0; i < KINDS.length; i += 1) {
        if (game.ammo[KINDS[i]] > 0) {
          game.selected = KINDS[i];
          return;
        }
      }
    }

    function radiusFor(kind) {
      return PROJECTILE_RADIUS[kind] || 12;
    }

    function makeProjectile(kind, x, y, vx, vy, launchPower) {
      return {
        kind: kind,
        x: x,
        y: y,
        vx: vx,
        vy: vy,
        radius: radiusFor(kind),
        life: 0,
        fuse: 0,
        launchPower: launchPower || 0,
        initialVy: vy,
        trail: [],
        split: false
      };
    }

    function launchLoaded(angleDegrees, power) {
      if (game.state !== 'aiming' || (game.ammo[game.selected] || 0) <= 0) return false;
      const p = clamp(Number(power) || 0, 0, 1);
      const angle = Number(angleDegrees) * Math.PI / 180;
      const speed = MAX_SPEED * p;
      const vx = Math.cos(angle) * speed;
      const vy = -Math.sin(angle) * speed;
      const kind = game.selected;
      game.ammo[kind] -= 1;
      game.projectiles.push(makeProjectile(kind, SLING_X, SLING_Y, vx, vy, p));
      game.shotTime = 0;
      game.quietTime = 0;
      game.explosions = [];
      markState('flying');
      return true;
    }

    function chooseAtEnd() {
      nextAvailableKind();
      if (targetsRemaining() === 0) {
        markState('won');
        return;
      }
      let rounds = 0;
      KINDS.forEach(function (kind) { rounds += game.ammo[kind] || 0; });
      if (rounds === 0) markState('lost');
      else markState('aiming');
    }

    function fireResultAction() {
      if (game.state === 'won') loadLevel(game.level < 3 ? game.level + 1 : 1);
      else if (game.state === 'lost') loadLevel(game.level);
    }

    function chooseKind(kind) {
      if (KINDS.indexOf(kind) < 0 || (game.ammo[kind] || 0) <= 0) return false;
      if (game.state !== 'aiming') return false;
      game.selected = kind;
      syncUI();
      render();
      return true;
    }

    function restart(level) {
      const n = Number(level);
      if (!Number.isInteger(n) || n < 1 || n > 3) return false;
      loadLevel(n);
      return true;
    }

    function bounds(body) {
      return {
        left: body.x - body.w / 2,
        right: body.x + body.w / 2,
        top: body.y - body.h / 2,
        bottom: body.y + body.h / 2
      };
    }

    function closestPoint(body, x, y) {
      const r = bounds(body);
      return { x: clamp(x, r.left, r.right), y: clamp(y, r.top, r.bottom) };
    }

    function removeBody(body) {
      const index = game.bodies.indexOf(body);
      if (index < 0) return;
      game.bodies.splice(index, 1);
      const points = body.kind === 'target' ? 2000 : MATERIALS[body.material].score;
      game.score += points;
      game.feedback.push({ x: body.x, y: body.y, text: '+' + points, life: 0, color: body.kind === 'target' ? '#fff1a6' : '#ffffff' });
      for (let i = 0; i < 11; i += 1) {
        const a = (Math.PI * 2 * i / 11) + Math.random() * 0.3;
        const speed = 45 + Math.random() * 180;
        game.particles.push({
          x: body.x,
          y: body.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - 45,
          life: 0.45 + Math.random() * 0.4,
          maxLife: 0.85,
          color: body.kind === 'target' ? '#ffe889' : (body.material === 'wood' ? '#e6a75b' : '#c4d7e3')
        });
      }
      if (body.kind === 'target' && targetsRemaining() === 0 && game.state !== 'won') {
        game.projectiles = [];
        markState('won');
      }
      syncUI();
    }

    function damageBody(body, amount) {
      if (!body || amount <= 0 || game.bodies.indexOf(body) < 0) return;
      body.hp -= amount;
      if (body.hp <= 0) removeBody(body);
    }

    function ignite(body) {
      if (!body || body.kind !== 'block' || body.material !== 'wood' || body.burning) return false;
      body.burning = true;
      body.burnTime = 0;
      body.spreadTime = 0;
      return true;
    }

    function touching(a, b) {
      const ar = bounds(a);
      const br = bounds(b);
      const gapX = Math.max(0, Math.max(ar.left - br.right, br.left - ar.right));
      const gapY = Math.max(0, Math.max(ar.top - br.bottom, br.top - ar.bottom));
      const nearX = gapX <= 4 && ar.top < br.bottom && ar.bottom > br.top;
      const nearY = gapY <= 4 && ar.left < br.right && ar.right > br.left;
      return nearX || nearY || (gapX <= 3 && gapY <= 3);
    }

    function spreadFire() {
      const burning = game.bodies.filter(function (body) { return body.burning; });
      for (let i = 0; i < burning.length; i += 1) {
        const source = burning[i];
        if (source.spreadTime < 0.45) continue;
        source.spreadTime = 0;
        for (let j = 0; j < game.bodies.length; j += 1) {
          const other = game.bodies[j];
          if (other !== source && other.material === 'wood' && !other.burning && touching(source, other)) ignite(other);
        }
      }
    }

    function explode(projectile) {
      removeProjectile(projectile);
      game.explosions.push({ x: projectile.x, y: projectile.y, age: 0, maxAge: 0.52 });
      for (let i = 0; i < 30; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const speed = 50 + Math.random() * 310;
        game.particles.push({
          x: projectile.x,
          y: projectile.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 0.3 + Math.random() * 0.45,
          maxLife: 0.75,
          color: i % 3 === 0 ? '#ffe890' : (i % 2 === 0 ? '#ff7a35' : '#d94127')
        });
      }
      const copy = game.bodies.slice();
      for (let i = 0; i < copy.length; i += 1) {
        const body = copy[i];
        const dx = body.x - projectile.x;
        const dy = body.y - projectile.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 80) continue;
        const factor = 1 - distance / 80;
        damageBody(body, 170 * factor);
        const length = Math.max(1, distance);
        const impulse = 360 * factor / Math.max(0.55, body.mass);
        body.vx += (distance > 0 ? dx / length : 0.15) * impulse;
        body.vy += (distance > 0 ? dy / length : -1) * impulse;
        body.onSurface = false;
      }
      syncUI();
    }

    function removeProjectile(projectile) {
      const index = game.projectiles.indexOf(projectile);
      if (index >= 0) game.projectiles.splice(index, 1);
    }

    function splitCluster(projectile) {
      if (!projectile || projectile.kind !== 'cluster' || projectile.split || game.state !== 'flying') return false;
      projectile.split = true;
      removeProjectile(projectile);
      const speed = Math.max(330, Math.sqrt(projectile.vx * projectile.vx + projectile.vy * projectile.vy) * 0.78);
      const direction = Math.atan2(projectile.vy, projectile.vx);
      [-0.23, 0, 0.23].forEach(function (spread, index) {
        const angle = direction + spread;
        const fragment = makeProjectile('fragment', projectile.x, projectile.y, Math.cos(angle) * speed, Math.sin(angle) * speed + (index - 1) * 28, projectile.launchPower);
        fragment.life = projectile.life;
        fragment.trail = projectile.trail.slice(-8);
        game.projectiles.push(fragment);
      });
      return true;
    }

    function projectileDamage(projectile, impactSpeed, body) {
      if (projectile.kind === 'fragment') return 10 + impactSpeed * 0.035;
      if (projectile.kind === 'cluster') return 16 + impactSpeed * 0.035;
      if (projectile.kind === 'stone') return 25 + impactSpeed * 0.082;
      if (projectile.kind === 'fire') return body.kind === 'target' ? 18 : 0;
      return 0;
    }

    function hitProjectile(projectile, body) {
      const speed = Math.sqrt(projectile.vx * projectile.vx + projectile.vy * projectile.vy);
      if (projectile.kind === 'bomb') {
        explode(projectile);
        return;
      }
      if (projectile.kind === 'fire') {
        if (ignite(body)) removeProjectile(projectile);
        else if (body.kind === 'target') {
          damageBody(body, projectileDamage(projectile, speed, body));
          removeProjectile(projectile);
        } else {
          projectile.vx *= 0.45;
          projectile.vy = Math.min(120, projectile.vy + 85);
        }
        return;
      }
      if (body.material === 'metal' && !(projectile.kind === 'stone' && projectile.launchPower >= 1)) {
        removeProjectile(projectile);
        return;
      }
      damageBody(body, projectileDamage(projectile, speed, body));
      if (game.bodies.indexOf(body) >= 0) {
        body.vx += projectile.vx * 0.29 / Math.max(0.55, body.mass);
        body.vy += projectile.vy * 0.17 / Math.max(0.55, body.mass);
        body.onSurface = false;
      }
      removeProjectile(projectile);
    }

    function stepProjectiles(dt) {
      const current = game.projectiles.slice();
      for (let i = 0; i < current.length; i += 1) {
        const projectile = current[i];
        if (game.projectiles.indexOf(projectile) < 0) continue;
        const previousVy = projectile.vy;
        projectile.life += dt;
        if (projectile.kind === 'bomb') {
          projectile.fuse += dt;
          if (projectile.fuse >= 1) {
            explode(projectile);
            continue;
          }
        }
        projectile.vy += GRAVITY * dt;
        projectile.x += projectile.vx * dt;
        projectile.y += projectile.vy * dt;
        projectile.trail.push({ x: projectile.x, y: projectile.y });
        if (projectile.trail.length > 15) projectile.trail.shift();

        if (projectile.kind === 'cluster' && !projectile.split) {
          const atApex = previousVy < 0 && projectile.vy >= 0;
          const horizontalTop = Math.abs(projectile.initialVy) < 1 && projectile.life >= 0.18;
          if (atApex || horizontalTop) {
            splitCluster(projectile);
            continue;
          }
        }

        if (projectile.y + projectile.radius >= GROUND) {
          if (projectile.kind === 'bomb') explode(projectile);
          else removeProjectile(projectile);
          continue;
        }

        let collided = false;
        for (let j = 0; j < game.bodies.length; j += 1) {
          const body = game.bodies[j];
          const near = closestPoint(body, projectile.x, projectile.y);
          const dx = projectile.x - near.x;
          const dy = projectile.y - near.y;
          if (dx * dx + dy * dy <= projectile.radius * projectile.radius) {
            hitProjectile(projectile, body);
            collided = true;
            break;
          }
        }
        if (collided) continue;
        if (projectile.x < -50 || projectile.x > WIDTH + 50 || projectile.y < -90 || projectile.y > HEIGHT + 90) {
          removeProjectile(projectile);
        }
      }
    }

    function resolveBodies(dt) {
      for (let i = 0; i < game.bodies.length; i += 1) {
        const body = game.bodies[i];
        body.onSurface = false;
        if (!body.onSurface) body.vy += GRAVITY * dt;
        body.x += body.vx * dt;
        body.y += body.vy * dt;
        body.vx *= 0.994;
        if (body.y + body.h / 2 >= GROUND) {
          const impact = Math.max(0, body.vy);
          body.y = GROUND - body.h / 2;
          body.vy = 0;
          body.onSurface = true;
          body.vx *= 0.84;
          if (impact > 180) damageBody(body, (impact - 150) * 0.018);
        }
        if (body.x - body.w / 2 < 0) {
          body.x = body.w / 2;
          body.vx = Math.max(0, body.vx * -0.18);
        }
        if (body.x + body.w / 2 > WIDTH) {
          body.x = WIDTH - body.w / 2;
          body.vx = Math.min(0, body.vx * -0.18);
        }
      }

      for (let iteration = 0; iteration < 2; iteration += 1) {
        for (let i = 0; i < game.bodies.length; i += 1) {
          const a = game.bodies[i];
          for (let j = i + 1; j < game.bodies.length; j += 1) {
            const b = game.bodies[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const overlapX = (a.w + b.w) / 2 - Math.abs(dx);
            const overlapY = (a.h + b.h) / 2 - Math.abs(dy);
            if (overlapX <= 0 || overlapY <= 0) continue;
            if (overlapY <= overlapX) {
              const relative = b.vy - a.vy;
              if (a.y <= b.y) {
                a.y -= overlapY;
                a.vy = Math.min(0, a.vy);
                b.vy = Math.max(0, b.vy);
                a.onSurface = true;
              } else {
                b.y -= overlapY;
                b.vy = Math.min(0, b.vy);
                a.vy = Math.max(0, a.vy);
                b.onSurface = true;
              }
              if (Math.abs(relative) > 210) {
                const force = (Math.abs(relative) - 180) * 0.014;
                damageBody(a, force);
                damageBody(b, force);
              }
            } else {
              const direction = dx >= 0 ? 1 : -1;
              const separation = overlapX / 2;
              a.x -= direction * separation;
              b.x += direction * separation;
              const relative = (b.vx - a.vx) * direction;
              if (relative < 0) {
                const shared = (a.vx + b.vx) / 2;
                a.vx = shared - direction * 3;
                b.vx = shared + direction * 3;
              }
              if (Math.abs(relative) > 220) {
                const force = (Math.abs(relative) - 180) * 0.012;
                damageBody(a, force);
                damageBody(b, force);
              }
            }
          }
        }
        for (let i = 0; i < game.bodies.length; i += 1) {
          const body = game.bodies[i];
          if (body.y + body.h / 2 > GROUND) {
            body.y = GROUND - body.h / 2;
            body.vy = Math.min(0, body.vy);
            body.onSurface = true;
          }
        }
      }

      for (let i = 0; i < game.bodies.length; i += 1) {
        const body = game.bodies[i];
        if (Math.abs(body.vx) < 2) body.vx = 0;
        if (Math.abs(body.vy) < 2) body.vy = 0;
      }
    }

    function updateBurning(dt) {
      const copy = game.bodies.slice();
      for (let i = 0; i < copy.length; i += 1) {
        const body = copy[i];
        if (!body.burning || game.bodies.indexOf(body) < 0) continue;
        body.burnTime += dt;
        body.spreadTime += dt;
        damageBody(body, body.maxHp * dt / 3);
      }
      spreadFire();
    }

    function updateEffects(dt) {
      game.explosions.forEach(function (effect) { effect.age += dt; });
      game.explosions = game.explosions.filter(function (effect) { return effect.age < effect.maxAge; });
      for (let i = game.particles.length - 1; i >= 0; i -= 1) {
        const particle = game.particles[i];
        particle.life -= dt;
        particle.vy += 260 * dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
        if (particle.life <= 0) game.particles.splice(i, 1);
      }
      for (let i = game.feedback.length - 1; i >= 0; i -= 1) {
        game.feedback[i].life += dt;
        game.feedback[i].y -= 24 * dt;
        if (game.feedback[i].life > 1.1) game.feedback.splice(i, 1);
      }
    }

    function bodiesQuiet() {
      for (let i = 0; i < game.bodies.length; i += 1) {
        const body = game.bodies[i];
        if (Math.abs(body.vx) > 13 || Math.abs(body.vy) > 13) return false;
      }
      return true;
    }

    function worldStillActive() {
      return game.bodies.some(function (body) {
        return body.burning || Math.abs(body.vx) > 1 || Math.abs(body.vy) > 1;
      });
    }

    function update(dt) {
      game.time += dt;
      updateEffects(dt);
      const inFlight = game.state === 'flying';
      if (inFlight) {
        game.shotTime += dt;
        stepProjectiles(dt);
      }
      if (game.state === 'flying' || (game.state === 'aiming' && worldStillActive())) {
        resolveBodies(dt);
        updateBurning(dt);
      }
      if (game.state !== 'flying') return;
      if (targetsRemaining() === 0) {
        if (game.state !== 'won') markState('won');
        return;
      }
      if (game.state !== 'flying') return;
      if (game.projectiles.length === 0 && bodiesQuiet() && game.explosions.length === 0) game.quietTime += dt;
      else game.quietTime = 0;
      if (game.shotTime >= 10 || game.quietTime >= 0.42) {
        game.projectiles = [];
        chooseAtEnd();
      }
    }

    function drawBackground() {
      const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
      sky.addColorStop(0, '#8bd7f5');
      sky.addColorStop(0.64, '#d6f0e7');
      sky.addColorStop(1, '#f9dc9e');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = 'rgba(255,250,220,.72)';
      ctx.beginPath();
      ctx.arc(1035, 98, 40, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 4; i += 1) {
        const x = 210 + i * 260;
        const y = 102 + (i % 2) * 34;
        ctx.fillStyle = 'rgba(255,255,255,.42)';
        ctx.beginPath();
        ctx.ellipse(x, y, 51, 15, 0, 0, Math.PI * 2);
        ctx.ellipse(x - 21, y + 3, 23, 12, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 19, y - 5, 26, 16, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#a3d7bb';
      ctx.beginPath();
      ctx.moveTo(0, 395);
      ctx.quadraticCurveTo(210, 300, 415, 395);
      ctx.quadraticCurveTo(620, 315, 825, 405);
      ctx.quadraticCurveTo(1020, 326, 1200, 405);
      ctx.lineTo(1200, GROUND);
      ctx.lineTo(0, GROUND);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#82c59f';
      ctx.beginPath();
      ctx.moveTo(0, 455);
      ctx.quadraticCurveTo(250, 385, 488, 455);
      ctx.quadraticCurveTo(780, 370, 1000, 452);
      ctx.quadraticCurveTo(1115, 423, 1200, 458);
      ctx.lineTo(1200, GROUND);
      ctx.lineTo(0, GROUND);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#6caa66';
      ctx.fillRect(0, GROUND, WIDTH, HEIGHT - GROUND);
      ctx.fillStyle = '#8ec66d';
      ctx.fillRect(0, GROUND, WIDTH, 9);
      ctx.fillStyle = 'rgba(42,91,58,.16)';
      for (let x = 12; x < WIDTH; x += 44) {
        ctx.fillRect(x, GROUND + 20 + (x % 3) * 6, 24, 3);
      }
      ctx.fillStyle = '#bd8a55';
      ctx.fillRect(0, GROUND + 42, WIDTH, HEIGHT - GROUND - 42);
      ctx.fillStyle = 'rgba(255,236,182,.25)';
      for (let x = 20; x < WIDTH; x += 72) ctx.fillRect(x, GROUND + 48 + (x % 4) * 4, 32, 2);
      ctx.fillStyle = 'rgba(44,92,63,.18)';
      ctx.fillRect(0, GROUND - 3, WIDTH, 3);
    }

    function drawCatapult() {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#66402c';
      ctx.lineWidth = 19;
      ctx.beginPath();
      ctx.moveTo(127, 548);
      ctx.lineTo(SLING_X, 455);
      ctx.lineTo(189, 548);
      ctx.stroke();
      ctx.strokeStyle = '#a56b3f';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(127, 548);
      ctx.lineTo(SLING_X, 455);
      ctx.lineTo(189, 548);
      ctx.stroke();
      ctx.fillStyle = '#d1a06a';
      ctx.fillRect(119, 539, 79, 15);
      ctx.fillStyle = '#f2cc86';
      ctx.fillRect(121, 539, 74, 4);
      ctx.strokeStyle = '#8d4a3b';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(SLING_X - 3, 458);
      ctx.lineTo(SLING_X - 27, 429);
      ctx.moveTo(SLING_X + 3, 458);
      ctx.lineTo(SLING_X + 22, 428);
      ctx.stroke();
      ctx.restore();
    }

    function drawBlock(body) {
      const left = body.x - body.w / 2;
      const top = body.y - body.h / 2;
      if (body.kind === 'target') {
        ctx.save();
        ctx.fillStyle = 'rgba(44,74,63,.18)';
        ctx.beginPath();
        ctx.ellipse(body.x, body.y + 16, 22, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#554338';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(body.x - 1, body.y + 15);
        ctx.lineTo(body.x - 1, body.y - 16);
        ctx.stroke();
        ctx.fillStyle = '#e85c52';
        ctx.beginPath();
        ctx.moveTo(body.x, body.y - 15);
        ctx.lineTo(body.x + 27, body.y - 7);
        ctx.lineTo(body.x, body.y + 1);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#fff2ce';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#fff4d5';
        ctx.beginPath();
        ctx.arc(body.x + 1, body.y - 7, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }
      let base;
      let topColor;
      let edge;
      if (body.material === 'wood') {
        base = '#b9783d'; topColor = '#d89a56'; edge = '#7e4c2c';
      } else if (body.material === 'stone') {
        base = '#657887'; topColor = '#a3b5bf'; edge = '#465967';
      } else {
        base = '#526a7d'; topColor = '#a9c0ca'; edge = '#304758';
      }
      ctx.save();
      ctx.fillStyle = 'rgba(48,70,60,.18)';
      ctx.fillRect(left + 4, top + body.h - 1, body.w, 8);
      const grad = ctx.createLinearGradient(left, top, left + body.w, top + body.h);
      grad.addColorStop(0, topColor);
      grad.addColorStop(1, base);
      ctx.fillStyle = grad;
      ctx.fillRect(left, top, body.w, body.h);
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      ctx.strokeRect(left + 1.5, top + 1.5, body.w - 3, body.h - 3);
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (body.material === 'wood') {
        ctx.moveTo(left + 7, top + 5);
        ctx.lineTo(left + body.w - 7, top + 5);
        ctx.moveTo(left + 7, top + body.h - 6);
        ctx.lineTo(left + body.w - 7, top + body.h - 6);
        if (body.w < 40) {
          ctx.moveTo(left + body.w / 2, top + 7);
          ctx.lineTo(left + body.w / 2, top + body.h - 7);
        }
      } else {
        ctx.moveTo(left + body.w * 0.33, top + 3);
        ctx.lineTo(left + body.w * 0.33, top + body.h - 3);
        ctx.moveTo(left + body.w * 0.67, top + 3);
        ctx.lineTo(left + body.w * 0.67, top + body.h - 3);
      }
      ctx.stroke();
      if (body.hp < body.maxHp * 0.55) {
        ctx.strokeStyle = 'rgba(49,43,40,.82)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(body.x - 5, body.y - 1);
        ctx.lineTo(body.x + 2, body.y + 4);
        ctx.lineTo(body.x - 1, body.y + 10);
        ctx.moveTo(body.x + 2, body.y + 4);
        ctx.lineTo(body.x + 9, body.y - 3);
        ctx.stroke();
      }
      if (body.burning) {
        const flicker = Math.sin(game.time * 22 + body.x * 0.04);
        ctx.fillStyle = 'rgba(255,119,36,.28)';
        ctx.beginPath();
        ctx.ellipse(body.x, top - 7, body.w * 0.48, 14 + flicker * 2, 0, 0, Math.PI * 2);
        ctx.fill();
        for (let flame = 0; flame < 3; flame += 1) {
          const fx = left + body.w * (0.22 + flame * 0.28);
          const height = 15 + Math.sin(game.time * 18 + flame * 2 + body.x) * 5;
          ctx.fillStyle = flame % 2 ? '#ffbd3c' : '#f65c2d';
          ctx.beginPath();
          ctx.moveTo(fx - 6, top + 3);
          ctx.quadraticCurveTo(fx - 10, top - height * 0.45, fx, top - height);
          ctx.quadraticCurveTo(fx + 8, top - height * 0.45, fx + 5, top + 3);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    function drawProjectile(projectile) {
      const r = projectile.radius;
      ctx.save();
      ctx.translate(projectile.x, projectile.y);
      if (projectile.kind === 'fire') {
        ctx.fillStyle = 'rgba(255,104,33,.26)';
        ctx.beginPath();
        ctx.arc(0, 0, r + 9 + Math.sin(game.time * 30) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
      const gradient = ctx.createRadialGradient(-r * 0.34, -r * 0.42, 1, 0, 0, r);
      gradient.addColorStop(0, projectile.kind === 'bomb' ? '#71717d' : '#fff2bd');
      gradient.addColorStop(0.28, PROJECTILE_COLOR[projectile.kind] || PROJECTILE_COLOR.stone);
      gradient.addColorStop(1, projectile.kind === 'fire' ? '#bc341d' : '#2a3641');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.78)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (projectile.kind === 'bomb') {
        ctx.strokeStyle = '#ed6b46';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-4, -r + 3);
        ctx.lineTo(3, -r - 5);
        ctx.lineTo(8, -r - 7);
        ctx.stroke();
      } else if (projectile.kind === 'fire') {
        ctx.fillStyle = '#ffd260';
        ctx.beginPath();
        ctx.arc(-2, -2, 3.5, 0, Math.PI * 2);
        ctx.fill();
      } else if (projectile.kind === 'cluster') {
        ctx.fillStyle = '#fff2c0';
        ctx.beginPath();
        ctx.arc(-4, -4, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function drawAim() {
      if (game.state !== 'aiming') return;
      let x = SLING_X;
      let y = SLING_Y;
      if (game.dragging && game.dragPoint) {
        const dx = game.dragPoint.x - SLING_X;
        const dy = game.dragPoint.y - SLING_Y;
        const length = Math.sqrt(dx * dx + dy * dy) || 1;
        const scale = Math.min(1, MAX_PULL / length);
        const pullX = dx * scale;
        const pullY = dy * scale;
        x = SLING_X + pullX;
        y = SLING_Y + pullY;
        const vx = -pullX / MAX_PULL * MAX_SPEED;
        const vy = -pullY / MAX_PULL * MAX_SPEED;
        ctx.save();
        ctx.strokeStyle = 'rgba(92,51,40,.84)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(SLING_X - 3, 458);
        ctx.lineTo(x, y);
        ctx.lineTo(SLING_X + 3, 458);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(38,61,71,.55)';
        ctx.setLineDash([3, 9]);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let i = 0; i <= 14; i += 1) {
          const t = i * 0.055;
          const px = x + vx * t;
          const py = y + vy * t + 0.5 * GRAVITY * t * t;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      drawProjectile({ kind: game.selected, x: x, y: y, radius: radiusFor(game.selected) });
    }

    function drawEffects() {
      game.projectiles.forEach(function (projectile) {
        if (projectile.trail.length < 2) return;
        ctx.save();
        ctx.lineCap = 'round';
        for (let i = 1; i < projectile.trail.length; i += 1) {
          const alpha = i / projectile.trail.length;
          ctx.strokeStyle = projectile.kind === 'fire' ? 'rgba(255,111,38,' + (alpha * 0.55) + ')' : 'rgba(46,63,72,' + (alpha * 0.3) + ')';
          ctx.lineWidth = 2 + alpha * 4;
          ctx.beginPath();
          ctx.moveTo(projectile.trail[i - 1].x, projectile.trail[i - 1].y);
          ctx.lineTo(projectile.trail[i].x, projectile.trail[i].y);
          ctx.stroke();
        }
        ctx.restore();
      });
      game.explosions.forEach(function (effect) {
        const progress = effect.age / effect.maxAge;
        const radius = 10 + progress * 92;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - progress);
        const burst = ctx.createRadialGradient(effect.x, effect.y, 1, effect.x, effect.y, radius);
        burst.addColorStop(0, '#fff4ae');
        burst.addColorStop(0.28, '#ffbf48');
        burst.addColorStop(0.68, '#f35d2d');
        burst.addColorStop(1, 'rgba(192,45,33,0)');
        ctx.fillStyle = burst;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,238,157,.86)';
        ctx.lineWidth = 4 - progress * 3;
        ctx.beginPath();
        ctx.arc(effect.x, effect.y, radius * 0.78, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
      game.particles.forEach(function (particle) {
        const alpha = clamp(particle.life / particle.maxLife, 0, 1);
        ctx.fillStyle = particle.color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, 2 + alpha * 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
      game.feedback.forEach(function (item) {
        ctx.save();
        ctx.globalAlpha = clamp(1 - item.life / 1.1, 0, 1);
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(61,52,43,.62)';
        ctx.strokeText(item.text, item.x, item.y);
        ctx.fillStyle = item.color;
        ctx.fillText(item.text, item.x, item.y);
        ctx.restore();
      });
    }

    function render() {
      if (!ctx) return;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);
      drawBackground();
      drawCatapult();
      const ordered = game.bodies.slice().sort(function (a, b) { return a.y - b.y; });
      ordered.forEach(drawBlock);
      drawEffects();
      drawAim();
      if (game.state === 'flying') game.projectiles.forEach(drawProjectile);
      if (game.state === 'won' || game.state === 'lost') {
        ctx.save();
        ctx.fillStyle = 'rgba(27,42,48,.18)';
        ctx.fillRect(0, 0, WIDTH, HEIGHT);
        ctx.restore();
      }
    }

    function updatePointer(event) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * WIDTH / rect.width,
        y: (event.clientY - rect.top) * HEIGHT / rect.height
      };
    }

    function pointerDown(event) {
      if (game.state === 'flying') {
        splitCluster(game.projectiles.find(function (p) { return p.kind === 'cluster' && !p.split; }));
        render();
        return;
      }
      if (game.state !== 'aiming' || !canvas || !canvas.getBoundingClientRect) return;
      const point = updatePointer(event);
      const dx = point.x - SLING_X;
      const dy = point.y - SLING_Y;
      if (dx * dx + dy * dy > 50 * 50) return;
      game.dragging = true;
      game.dragPoint = point;
      game.pointerId = event.pointerId;
      if (canvas.setPointerCapture && event.pointerId !== undefined) {
        try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
      }
      if (event.preventDefault) event.preventDefault();
      render();
    }

    function pointerMove(event) {
      if (!game.dragging || (game.pointerId !== null && event.pointerId !== game.pointerId)) return;
      const point = updatePointer(event);
      const dx = point.x - SLING_X;
      const dy = point.y - SLING_Y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const factor = Math.min(1, MAX_PULL / distance);
      game.dragPoint = { x: SLING_X + dx * factor, y: SLING_Y + dy * factor };
      if (event.preventDefault) event.preventDefault();
      render();
    }

    function pointerUp(event) {
      if (!game.dragging || (game.pointerId !== null && event.pointerId !== game.pointerId)) return;
      const point = updatePointer(event);
      const dx = point.x - SLING_X;
      const dy = point.y - SLING_Y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const pull = Math.min(MAX_PULL, distance);
      if (pull >= 5) {
        const angle = Math.atan2(dy, -dx) * 180 / Math.PI;
        launchLoaded(angle, pull / MAX_PULL);
      } else {
        game.dragging = false;
        game.dragPoint = null;
        game.pointerId = null;
        render();
      }
      if (event.preventDefault) event.preventDefault();
    }

    function attachUI() {
      KINDS.forEach(function (kind) {
        const button = ammoButtons[kind];
        if (button && button.addEventListener) button.addEventListener('click', function () { chooseKind(kind); });
      });
      if (ui.restartButton && ui.restartButton.addEventListener) ui.restartButton.addEventListener('click', function () { restart(game.level); });
      if (ui.resultButton && ui.resultButton.addEventListener) ui.resultButton.addEventListener('click', fireResultAction);
      if (canvas && canvas.addEventListener) {
        canvas.addEventListener('pointerdown', pointerDown);
        canvas.addEventListener('pointermove', pointerMove);
        canvas.addEventListener('pointerup', pointerUp);
        canvas.addEventListener('pointercancel', pointerUp);
        canvas.addEventListener('contextmenu', function (event) { if (event.preventDefault) event.preventDefault(); });
      }
    }

    function tick(timestamp, token) {
      if (token !== generation || paused) return;
      if (lastFrame === null) lastFrame = timestamp;
      else {
        accumulator += clamp((timestamp - lastFrame) / 1000, 0, 0.1);
        lastFrame = timestamp;
        while (accumulator >= FIXED_STEP) {
          update(FIXED_STEP);
          accumulator -= FIXED_STEP;
        }
      }
      render();
      frameHandle = requestFrame(function (next) { tick(next, token); });
    }

    function startClock() {
      if (!paused) return;
      paused = false;
      lastFrame = null;
      accumulator = 0;
      generation += 1;
      const token = generation;
      frameHandle = requestFrame(function (timestamp) { tick(timestamp, token); });
    }

    function stopClock() {
      if (paused) return;
      paused = true;
      generation += 1;
      lastFrame = null;
      accumulator = 0;
      if (frameHandle !== null) cancelFrame(frameHandle);
      frameHandle = null;
    }

    const test = {
      pause: stopClock,
      step: function (milliseconds) {
        let remaining = Math.max(0, Number(milliseconds) || 0) / 1000;
        while (remaining > 0) {
          const dt = Math.min(FIXED_STEP, remaining);
          update(dt);
          remaining -= dt;
        }
        render();
      },
      resume: startClock,
      select: chooseKind,
      launch: launchLoaded,
      trigger: function () {
        return splitCluster(game.projectiles.find(function (p) { return p.kind === 'cluster' && !p.split; }));
      },
      restart: restart,
      snapshot: function () {
        return {
          state: game.state,
          level: game.level,
          score: game.score,
          ammo: Object.assign({}, game.ammo),
          selected: game.selected,
          targets: targetsRemaining(),
          projectiles: game.projectiles.map(projectileSnapshot),
          bodies: game.bodies.map(bodySnapshot)
        };
      }
    };

    attachUI();
    loadLevel(1);
    if (options.autoStart !== false) startClock();

    return { test: test, render: render, update: update, state: game };
  }

  return {
    createGame: createGame,
    constants: {
      width: WIDTH,
      height: HEIGHT,
      ground: GROUND,
      gravity: GRAVITY,
      maxPull: MAX_PULL,
      maxSpeed: MAX_SPEED,
      fixedStep: FIXED_STEP,
      kinds: KINDS.slice()
    }
  };
});
