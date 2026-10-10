// Times `visp ui` against docs/specs/visp-ui.md §16: first render with 20 slices and
// 200 executions (acceptance item 6) and a CLI state change reaching an open page
// within 500 ms (item 2). Not part of CI; needs a build and playwright-core:
//   pnpm build
//   VISP_UI_LARGE=/tmp/visp-ui-large pnpm vitest run tests/integration/ui/large-demo.test.ts
//   npm install --prefix /tmp/pw playwright-core   # any recent version
//   NODE_PATH=/tmp/pw/node_modules node bench/ui/bench-ui.mjs /tmp/visp-ui-large out.json --live
// CHROME_BIN selects the browser; TRIALS (default 7) and RATES (CPU throttling, default
// 1,2,4) tune the run. Runs on a copy of the fixture, which stays as seeded.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright-core");
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const [fixture, outFile] = process.argv.slice(2);
const live = process.argv.includes("--live");
const TRIALS = Number(process.env.TRIALS ?? 7);
const RATES = (process.env.RATES ?? "1,2,4").split(",").map(Number);

// Work on a copy so the fixture stays as seeded.
const project = `${fixture}-run-${process.pid}`;
rmSync(project, { recursive: true, force: true });
cpSync(fixture, project, { recursive: true });
const feature = readdirSync(join(project, ".visp/features"))[0];
const executions = () =>
  JSON.parse(readFileSync(join(project, ".visp/features", feature, "product-state.json"), "utf8"))
    .executions.length;
const visp = (args, input) =>
  execFileSync(process.execPath, [CLI, "--project", project, ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

function startServer() {
  const child = spawn(process.execPath, [CLI, "--project", project, "--json", "ui", "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.includes('"url"'));
      if (line) resolve({ child, url: JSON.parse(line).data.url });
    });
    child.on("exit", (code) => reject(new Error(`visp ui exited ${code}`)));
    setTimeout(() => reject(new Error("visp ui did not announce")), 20_000);
  });
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};
const round = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v) : v)));

async function settle(page, selector) {
  let last = -1;
  for (let stable = 0; stable < 10; ) {
    await page.waitForTimeout(200);
    const n = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
    stable = n === last && n > 0 ? stable + 1 : 0;
    last = n;
  }
  return last;
}

// Records when the selector count first reaches the target, and one frame later.
const watchScript = ({ selector, target }) => {
  window.__done = null;
  window.__painted = null;
  const observer = new MutationObserver(() => {
    if (window.__done === null && document.querySelectorAll(selector).length >= target) {
      window.__done = performance.now();
      observer.disconnect();
      requestAnimationFrame(() => setTimeout(() => (window.__painted = performance.now()), 0));
    }
  });
  observer.observe(document, { childList: true, subtree: true });
};

async function main() {
  const { child, url } = await startServer();
  const origin = new URL(url).origin;
  const browser = await chromium.launch(
    process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {},
  );
  const results = { fixture, feature, executionsInState: executions(), firstRender: {}, live: {} };
  try {
    // Sign in once; later contexts reuse the cookie with a cold HTTP cache.
    const signIn = await browser.newContext();
    const page0 = await signIn.newPage();
    await page0.goto(url);
    await page0.waitForFunction(() => location.hash === "#/");
    const cookies = await signIn.cookies();

    // Untimed warm-up: how many marks and run rows the fully loaded page shows.
    const route = (tab) => `${origin}/#/f/${encodeURIComponent(feature)}/${tab}`;
    await page0.goto(route("now"));
    const counts = { marks: await settle(page0, '[data-key^="mark:"]') };
    counts.checks = await page0.evaluate(() => document.querySelectorAll('[data-key^="check:"]').length);
    await page0.goto(route("runs"));
    counts.runRows = await settle(page0, '[data-key^="run:"]');
    results.counts = counts;
    await signIn.close();

    const targets = [
      ["now", '[data-key^="mark:"]', counts.marks],
      ["runs", '[data-key^="run:"]', counts.runRows],
    ];
    for (const rate of RATES) {
      for (const [tab, selector, target] of targets) {
        const done = [];
        const painted = [];
        const api = [];
        for (let trial = 0; trial < TRIALS; trial++) {
          const context = await browser.newContext();
          await context.addCookies(cookies);
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate });
          await page.addInitScript(watchScript, { selector, target });
          await page.goto(route(tab), { waitUntil: "commit" });
          await page.waitForFunction(() => window.__painted !== null, null, { timeout: 60_000 });
          const sample = await page.evaluate(() => ({
            done: window.__done,
            painted: window.__painted,
            api: performance
              .getEntriesByType("resource")
              .filter((e) => e.name.includes(`/api/v1/features/`))
              .map((e) => e.responseEnd - e.requestStart),
          }));
          done.push(sample.done);
          painted.push(sample.painted);
          api.push(Math.max(0, ...sample.api));
          await context.close();
        }
        results.firstRender[`${tab}@${rate}x`] = round({
          target,
          domComplete: stats(done),
          painted: stats(painted),
          featureApi: stats(api),
        });
        console.error(`${tab} ${rate}x painted median ${Math.round(stats(painted).median)} ms`);
      }
    }

    if (live) results.live = await liveTrials(browser, cookies, route, counts);
  } finally {
    await browser.close();
    child.kill("SIGINT");
    writeFileSync(outFile, `${JSON.stringify(results, null, 1)}\n`);
    rmSync(project, { recursive: true, force: true });
  }
}

/** Newest and oldest mtime under .visp written since `since`. */
function writesSince(since) {
  let first = Number.POSITIVE_INFINITY;
  let last = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const m = statSync(path).mtimeMs;
        if (m >= since) {
          first = Math.min(first, m);
          last = Math.max(last, m);
        }
      }
    }
  };
  walk(join(project, ".visp"));
  return { first, last };
}

async function liveTrials(browser, cookies, route, counts) {
  const out = {};
  for (const rate of [1, 4]) {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const sse = [];
    await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", (e) => {
      if (e.eventName === "change") sse.push(Date.now());
    });
    await page.addInitScript(() => {
      window.__log = [];
      window.__marker = null;
      window.__baseline = null;
      const note = () => {
        const keys = [...document.querySelectorAll('[data-key^="mark:"]')].map((e) => e.dataset.key);
        window.__log.push({
          t: Date.now(),
          marks: window.__baseline ? keys.filter((k) => !window.__baseline.has(k)).length : 0,
          text: window.__marker && document.body?.textContent.includes(window.__marker) ? window.__marker : "",
        });
        if (window.__log.length > 400) window.__log.splice(0, 200);
      };
      new MutationObserver(note).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await page.goto(route("now"));
    await page.waitForFunction((n) => document.querySelectorAll('[data-key^="mark:"]').length >= n, counts.marks);
    await page.waitForTimeout(2000);

    const kinds = {
      // visp verify records a new execution: a new mark in the thread.
      verify: async (k) => {
        await page.evaluate(() => {
          window.__baseline = new Set(
            [...document.querySelectorAll('[data-key^="mark:"]')].map((e) => e.dataset.key),
          );
        });
        const source = join(project, "src/m20.mjs");
        writeFileSync(source, `export const value = () => 20; // live ${rate}-${k}\n`);
        const start = Date.now();
        visp(["verify", "--task", "T020"]);
        return { start, exit: Date.now(), seen: (e) => e.marks > 0 };
      },
      // visp brief --patch adds a decision shown on the Now page.
      brief: async (k) => {
        const marker = `Live marker ${rate}-${k}`;
        await page.evaluate((m) => (window.__marker = m), marker);
        const start = Date.now();
        visp(
          ["brief", "--patch", "-", "--reason", marker],
          JSON.stringify({ decisions: [{ statement: marker, rationale: "live update trial" }] }),
        );
        return { start, exit: Date.now(), seen: (e) => e.text.includes(marker) };
      },
    };
    for (const [kind, act] of Object.entries(kinds)) {
      const fromWrite = [];
      const fromExit = [];
      const sseFromWrite = [];
      const missed = [];
      for (let k = 0; k < TRIALS; k++) {
        sse.length = 0;
        await page.evaluate(() => (window.__log = []));
        const { start, exit, seen } = await act(k);
        const writes = writesSince(start);
        const deadline = Date.now() + 15_000;
        let at;
        while (!at && Date.now() < deadline) {
          const log = await page.evaluate(() => window.__log.map(({ t, marks, text }) => ({ t, marks, text })));
          at = log.find(seen)?.t;
          if (!at) await page.waitForTimeout(50);
        }
        if (!at) {
          missed.push(k);
          continue;
        }
        fromWrite.push(at - writes.last);
        fromExit.push(at - exit);
        if (sse.length) sseFromWrite.push(sse[0] - writes.first);
        await page.waitForTimeout(1200);
      }
      out[`${kind}@${rate}x`] = round({
        fromLastStateWrite: stats(fromWrite),
        fromCommandExit: stats(fromExit),
        sseEventAfterFirstWrite: sseFromWrite.length ? stats(sseFromWrite) : null,
        missed,
      });
      console.error(`live ${kind} ${rate}x median ${Math.round(stats(fromWrite).median)} ms, missed ${missed.length}`);
    }
    await context.close();
  }
  return out;
}

await main();
