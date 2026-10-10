// Hidden browser checks for slingshot-game. Run by hidden_test.py with GAME_URL, CHROME_BIN and
// PLAYWRIGHT_CORE set; prints {"results": [...]}.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const URL_ = process.env.GAME_URL;
const results = [];
const record = (name, passed, detail = "") => results.push({ name, passed: !!passed, detail: String(detail).slice(0, 400) });

async function check(name, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) record(name, true);
    else record(name, false, out);
  } catch (error) {
    record(name, false, error?.message ?? error);
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN, headless: true });

async function openPage(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, ...extra });
  const page = await context.newPage();
  const errors = [];
  const foreign = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Browsers ask for /favicon.ico on their own; a missing one is not a game error.
  page.on("console", (m) => m.type() === "error" && !/\/favicon\.ico$/.test(m.location()?.url ?? "") && errors.push(m.text()));
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(new URL(URL_).origin) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u);
  });
  await page.goto(URL_, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(500);
  return { page, context, errors, foreign };
}

const attrs = (page) =>
  page.evaluate(() => {
    const g = document.querySelector("#game");
    if (!g) return null;
    const d = g.dataset;
    return { state: d.state, level: Number(d.level), score: Number(d.score), birds: Number(d.birds), pigs: Number(d.pigs) };
  });
const snap = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.gameTest.snapshot())));
const call = (page, expr) => page.evaluate(expr);
// Advance until the turn ends (or maxMs), in 100 ms chunks, inside the page.
const finishTurn = (page, maxMs = 9500) =>
  page.evaluate((maxMs) => {
    const g = document.querySelector("#game");
    for (let t = 0; t < maxMs; t += 100) {
      window.gameTest.step(100);
      if (g.dataset.state !== "flying") return t + 100;
    }
    return -1;
  }, maxMs);
const shoot = async (page, angle, power) => {
  await call(page, `window.gameTest.launch(${angle}, ${power})`);
  return finishTurn(page);
};
const fresh = async (page, level = 1) => {
  await call(page, `window.gameTest.pause(); window.gameTest.restart(${level}); window.gameTest.pause();`);
};
const noScroll = (page) =>
  page.evaluate(() => {
    const el = document.scrollingElement;
    const g = document.querySelector("#game").getBoundingClientRect();
    return {
      scroll: el.scrollWidth > innerWidth + 1 || el.scrollHeight > innerHeight + 1,
      inside: g.left >= -1 && g.top >= -1 && g.right <= innerWidth + 1 && g.bottom <= innerHeight + 1,
      ratio: g.width / g.height,
      w: g.width,
    };
  });
const buttonVisible = (page, pattern) =>
  page.evaluate((source) => {
    const re = new RegExp(source, "i");
    return [...document.querySelectorAll("button, [role=button], a, input[type=button]")].some((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b);
      return re.test(b.textContent || b.value || "") && r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    });
  }, pattern);
const clickButton = (page, pattern) =>
  page.evaluate((source) => {
    const re = new RegExp(source, "i");
    const b = [...document.querySelectorAll("button, [role=button], a, input[type=button]")].find((b) => {
      const r = b.getBoundingClientRect();
      return re.test(b.textContent || b.value || "") && r.width > 0 && r.height > 0;
    });
    if (!b) return false;
    b.click();
    return true;
  }, pattern);

const desktop = await openPage({ width: 1280, height: 800 });
const page = desktop.page;
let initial;

await check("loads without errors", async () => (desktop.errors.length ? desktop.errors.join(" | ") : true));
await check("test hooks present", async () => {
  const missing = await page.evaluate(() =>
    ["pause", "step", "resume", "launch", "restart", "snapshot"].filter((k) => typeof window.gameTest?.[k] !== "function"),
  );
  return missing.length ? `missing ${missing.join(", ")}` : true;
});
await check("initial state", async () => {
  await fresh(page);
  initial = await attrs(page);
  const s = await snap(page);
  const pigBodies = s.bodies.filter((b) => b.kind === "pig").length;
  if (!initial) return "no #game";
  const ok =
    initial.state === "aiming" && initial.level === 1 && initial.birds === 3 && initial.score === 0 && initial.pigs >= 1 &&
    s.pigs === initial.pigs && pigBodies === initial.pigs && s.bird && s.state === "aiming";
  return ok || JSON.stringify({ initial, snap: { ...s, bodies: s.bodies.length } });
});
await check("fits a 1280x800 window", async () => {
  const r = await noScroll(page);
  return (!r.scroll && r.inside && Math.abs(r.ratio - 960 / 540) < 0.06) || JSON.stringify(r);
});
await check("launch starts a flight", async () => {
  await fresh(page);
  await call(page, "window.gameTest.launch(45, 1)");
  const a = await attrs(page);
  const s = await snap(page);
  return (a.state === "flying" && a.birds === 2 && s.bird && s.bird.vx > 0 && s.bird.vy < 0) || JSON.stringify({ a, bird: s.bird });
});
await check("gravity bends the flight into an arc", async () => {
  await fresh(page);
  await call(page, "window.gameTest.launch(50, 1)");
  const samples = await page.evaluate(() => {
    const out = [];
    for (let i = 0; i < 90; i++) {
      window.gameTest.step(1000 / 60);
      const b = window.gameTest.snapshot().bird;
      if (!b) break;
      out.push(b);
    }
    return out;
  });
  if (samples.length < 20) return `only ${samples.length} samples`;
  const early = samples.slice(0, 20);
  const vyRising = early.every((b, i) => i === 0 || b.vy >= early[i - 1].vy - 1e-6) && early.at(-1).vy > early[0].vy;
  const minY = Math.min(...samples.map((b) => b.y));
  const apex = samples.findIndex((b) => b.y === minY);
  const falls = apex > 0 && samples.slice(apex).some((b) => b.y > minY + 5);
  const forward = early.at(-1).x > early[0].x;
  return (vyRising && falls && forward) || JSON.stringify({ vyRising, apex, falls, forward, first: samples[0], last: samples.at(-1) });
});
await check("launch speed scales with pull", async () => {
  const speed = async (power) => {
    await fresh(page);
    await call(page, `window.gameTest.launch(30, ${power})`);
    const b = (await snap(page)).bird;
    return Math.hypot(b.vx, b.vy);
  };
  const half = await speed(0.5);
  const full = await speed(1);
  const ratio = full / half;
  return (ratio > 1.8 && ratio < 2.2) || `half ${half.toFixed(1)} full ${full.toFixed(1)}`;
});
await check("launch angle sets the direction", async () => {
  const angle = async (deg) => {
    await fresh(page);
    await call(page, `window.gameTest.launch(${deg}, 1)`);
    const b = (await snap(page)).bird;
    return (Math.atan2(-b.vy, b.vx) * 180) / Math.PI;
  };
  const got = [await angle(20), await angle(60)];
  return (Math.abs(got[0] - 20) < 6 && Math.abs(got[1] - 60) < 6) || `measured ${got.map((g) => g.toFixed(1))}`;
});
await check("nothing falls through the ground", async () => {
  await fresh(page);
  await call(page, "window.gameTest.launch(15, 0.35)");
  const worst = await page.evaluate(() => {
    let max = -Infinity;
    for (let i = 0; i < 300; i++) {
      window.gameTest.step(1000 / 60);
      const s = window.gameTest.snapshot();
      if (s.bird) max = Math.max(max, s.bird.y);
      for (const b of s.bodies) max = Math.max(max, b.y);
      if (document.querySelector("#game").dataset.state !== "flying") break;
    }
    return max;
  });
  return worst <= 500 || `lowest center y ${worst.toFixed(1)}`;
});
await check("turn ends and the next bird is ready", async () => {
  await fresh(page);
  const t = await shoot(page, 45, 0.6);
  const a = await attrs(page);
  const s = await snap(page);
  return (t > 0 && t <= 9000 && ((a.state === "aiming" && a.birds === 2 && !!s.bird) || a.state === "won")) || JSON.stringify({ t, a });
});

// One shot from a fresh level, followed in the page: body changes, score and which blocks
// the bird's center came near (it cannot pass through a block unaffected).
async function trial(level, angle, power) {
  await fresh(page, level);
  return page.evaluate(([angle, power]) => {
    const g = window.gameTest;
    const game = document.querySelector("#game");
    const before = g.snapshot().bodies;
    const blocks = before.filter((b) => b.kind === "block").map((b) => ({ ...b, near: Infinity }));
    g.launch(angle, power);
    let t = 0;
    for (; t < 9500; t += 1000 / 60) {
      const bird = g.snapshot().bird;
      if (bird && game.dataset.state === "flying")
        for (const b of blocks) b.near = Math.min(b.near, Math.hypot(bird.x - b.x, bird.y - b.y));
      g.step(1000 / 60);
      if (game.dataset.state !== "flying") break;
    }
    const after = g.snapshot();
    const count = (list, k) => list.filter((b) => b.kind === k).length;
    const reached = blocks.filter((b) => b.near < 12).map((b) => {
      const same = after.bodies
        .filter((a) => a.kind === "block")
        .find((a) => Math.hypot(a.x - b.x, a.y - b.y) < 2 && a.hp === b.hp);
      return !same; // removed, moved or damaged
    });
    return {
      angle, power, t,
      pigs: count(before, "pig") - count(after.bodies, "pig"),
      blocks: count(before, "block") - count(after.bodies, "block"),
      score: after.score,
      state: after.state,
      reached,
    };
  }, [angle, power]);
}
let sweep = [];
await check("shots can destroy bodies", async () => {
  for (const power of [1, 0.8, 0.6]) {
    for (let angle = 5; angle <= 70; angle += 5) sweep.push(await trial(1, angle, power));
  }
  return sweep.some((r) => r.pigs + r.blocks > 0) || "no shot from 5–70° at power 0.6–1 destroyed anything";
});
await check("the bird cannot pass through blocks", async () => {
  const reached = sweep.flatMap((r) => r.reached);
  // A solid block keeps the bird's center out, so correct games usually reach none.
  const untouched = reached.filter((hit) => !hit).length;
  return untouched === 0 || `${untouched} of ${reached.length} blocks the bird reached were unaffected`;
});
await check("a pig can be destroyed", async () => sweep.some((r) => r.pigs > 0) || "no single shot destroyed a pig");
await check("score counts removed blocks and pigs", async () => {
  const hits = sweep.filter((r) => r.pigs + r.blocks > 0);
  if (!hits.length) return "no removals to score";
  const wrong = hits.filter((r) => r.score !== 500 * r.blocks + 5000 * r.pigs);
  return !wrong.length || JSON.stringify(wrong.slice(0, 3));
});

await check("losing all birds ends the level as lost", async () => {
  await fresh(page);
  const pigs = (await attrs(page)).pigs;
  for (let i = 0; i < 3; i++) await shoot(page, 180, 1); // straight back out of the world
  const a = await attrs(page);
  return (a.state === "lost" && a.birds === 0 && a.pigs === pigs) || JSON.stringify(a);
});
await check("ui: a retry button follows a loss", async () => (await buttonVisible(page, "retry")) || "no visible DOM button labelled Retry");
await check("ui: retry restores the level", async () => {
  const clicked = await clickButton(page, "retry");
  await call(page, "window.gameTest.pause()");
  const a = await attrs(page);
  return (clicked && a.state === "aiming" && a.birds === 3 && a.score === 0 && a.pigs === initial.pigs) || JSON.stringify({ clicked, a });
});
await check("ui: restart button restarts the current level", async () => {
  await fresh(page);
  await shoot(page, 45, 0.6);
  const visible = await buttonVisible(page, "restart");
  const clicked = await clickButton(page, "restart");
  await call(page, "window.gameTest.pause()");
  const a = await attrs(page);
  return (visible && clicked && a.state === "aiming" && a.birds === 3 && a.score === 0 && a.level === 1) || JSON.stringify({ visible, clicked, a });
});

// Greedy search for a 3-bird win on level 1, replaying the chosen shots after each restart.
let winning = null;
await check("level 1 can be won within 3 birds", async () => {
  const candidates = [];
  for (const power of [1, 0.85, 0.7, 0.55]) for (let angle = 5; angle <= 75; angle += 5) candidates.push([angle, power]);
  const chosen = [];
  for (let bird = 0; bird < 3; bird++) {
    let best = null;
    for (const [angle, power] of candidates) {
      await fresh(page);
      for (const [a, p] of chosen) await shoot(page, a, p);
      await shoot(page, angle, power);
      const a = await attrs(page);
      if (!best || a.pigs < best.pigs || (a.pigs === best.pigs && a.score > best.score)) best = { angle, power, pigs: a.pigs, score: a.score, state: a.state };
      if (a.state === "won") break;
    }
    chosen.push([best.angle, best.power]);
    if (best.state === "won") {
      winning = chosen;
      return true;
    }
  }
  return `best sequence ${JSON.stringify(chosen)} left pigs`;
});
await check("clearing every pig wins the level", async () => {
  if (!winning) return "no winning sequence found";
  await fresh(page);
  for (const [a, p] of winning.slice(0, -1)) await shoot(page, a, p);
  const [a, p] = winning.at(-1);
  await call(page, `window.gameTest.launch(${a}, ${p})`);
  const wonAt = await page.evaluate(() => {
    const g = document.querySelector("#game");
    for (let t = 0; t < 9500; t += 1000 / 60) {
      window.gameTest.step(1000 / 60);
      if (Number(g.dataset.pigs) === 0) return g.dataset.state;
    }
    return "never";
  });
  return wonAt === "won" || `state when the last pig went: ${wonAt}`;
});
await check("ui: a next level button follows a win", async () => {
  if (!winning) return "no win reached";
  return (await buttonVisible(page, "next level")) || "no visible DOM button labelled Next level";
});
await check("ui: next level starts level 2", async () => {
  if (!winning) return "no win to continue from";
  const clicked = await clickButton(page, "next level");
  await call(page, "window.gameTest.pause()");
  const a = await attrs(page);
  return (clicked && a.level === 2 && a.birds === 3 && a.score === 0 && a.state === "aiming" && a.pigs >= 1) || JSON.stringify({ clicked, a });
});
await check("three distinct levels", async () => {
  const layouts = [];
  for (const level of [1, 2, 3]) {
    await fresh(page, level);
    const a = await attrs(page);
    const s = await snap(page);
    if (a.level !== level || a.pigs < 1 || a.birds !== 3) return JSON.stringify({ level, a });
    layouts.push(JSON.stringify(s.bodies.map((b) => [b.kind, Math.round(b.x), Math.round(b.y)])));
  }
  return new Set(layouts).size === 3 || "layouts repeat";
});
await check("ui: level, score and birds are shown", async () => {
  await fresh(page, 2);
  const text = await page.evaluate(() => document.body.innerText.toLowerCase());
  return (/level/.test(text) && /score/.test(text) && /bird/.test(text)) || text.slice(0, 200);
});
await check("mouse drag on the bird launches it", async () => {
  await fresh(page);
  const box = await page.evaluate(() => {
    const r = document.querySelector("#game").getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width / 960 };
  });
  const bird = (await snap(page)).bird;
  const x = box.left + bird.x * box.scale;
  const y = box.top + bird.y * box.scale;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - 8 * i * box.scale, y + 5 * i * box.scale);
  await page.mouse.up();
  const a = await attrs(page);
  const b = (await snap(page)).bird;
  return (a.state === "flying" && a.birds === 2 && b && b.vx > 0 && b.vy < 0) || JSON.stringify({ a, b });
});
await check("no requests outside the project", async () => (desktop.foreign.length ? desktop.foreign.slice(0, 3).join(" ") : true));
await desktop.context.close();

const phone = await openPage({ width: 390, height: 844 }, { hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
await check("fits a 390x844 phone", async () => {
  const r = await noScroll(phone.page);
  return (!r.scroll && r.inside && Math.abs(r.ratio - 960 / 540) < 0.06 && r.w > 300) || JSON.stringify(r);
});
await check("touch drag on the bird launches it", async () => {
  const p = phone.page;
  await fresh(p);
  const box = await p.evaluate(() => {
    const r = document.querySelector("#game").getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width / 960 };
  });
  const bird = (await snap(p)).bird;
  const x = box.left + bird.x * box.scale;
  const y = box.top + bird.y * box.scale;
  const cdp = await p.context().newCDPSession(p);
  const touch = (type, px, py) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: px, y: py }] });
  await touch("touchStart", x, y);
  for (let i = 1; i <= 8; i++) await touch("touchMove", x - 8 * i * box.scale, y + 5 * i * box.scale);
  await touch("touchEnd", 0, 0);
  const a = await attrs(p);
  return (a.state === "flying" && a.birds === 2) || JSON.stringify(a);
});
await phone.context.close();
await browser.close();
console.log(JSON.stringify({ results }));
