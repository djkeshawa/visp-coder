// Times `visp ui` against docs/specs/visp-ui.md §16: first render with 20 slices and
// 200 executions (acceptance item 6) and a CLI state change reaching an open page
// within 500 ms (item 2). Not part of CI; needs a build and playwright-core:
//   pnpm build
//   VISP_UI_LARGE=/tmp/visp-ui-large pnpm vitest run tests/integration/ui/large-demo.test.ts
//   npm install --prefix /tmp/pw playwright-core   # any recent version
//   NODE_PATH=/tmp/pw/node_modules node bench/ui/bench-ui.mjs /tmp/visp-ui-large out.json --live
// CHROME_BIN selects the browser. TRIALS (default 7) sets the trials per measure, RATES
// (CPU throttling, default 1,2,4) the first-render rates and LIVE_RATES (default 1,4)
// the live-update rates. Runs on a copy of the fixture, which stays as seeded.
import { execFile, spawn } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const { chromium } = createRequire(import.meta.url)("playwright-core");
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const [fixtureArg, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!fixtureArg || !outFile) {
  console.error("usage: node bench/ui/bench-ui.mjs <fixture> <out.json> [--live]");
  process.exit(2);
}
// resolve() drops a trailing separator, so the copy is a sibling, never inside the fixture.
const fixture = resolve(fixtureArg);
const live = process.argv.includes("--live");
const TRIALS = Number(process.env.TRIALS ?? 7);
const rates = (value) => value.split(",").map(Number);
const RATES = rates(process.env.RATES ?? "1,2,4");
const LIVE_RATES = rates(process.env.LIVE_RATES ?? "1,4");
const MARK = '[data-key^="mark:"]';

const project = `${fixture}-run-${process.pid}`;
const executions = (feature) =>
  JSON.parse(readFileSync(join(project, ".visp/features", feature, "product-state.json"), "utf8"))
    .executions.length;
// Asynchronous, so CDP events keep being handled (and timestamped) while the command runs.
const visp = (args, input) => {
  const run = promisify(execFile)(process.execPath, [CLI, "--project", project, ...args], {
    encoding: "utf8",
  });
  run.child.stdin.end(input ?? "");
  return run;
};

function startServer() {
  const child = spawn(process.execPath, [CLI, "--project", project, "--json", "ui", "--no-open"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const announced = new Promise((resolveUrl, reject) => {
    let buffer = "";
    const fail = (error) => {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("visp ui did not announce")), 20_000);
    const onData = (chunk) => {
      buffer += chunk;
      const line = buffer.split("\n").find((l) => l.includes('"url"'));
      if (!line) return;
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.stdout.resume(); // keep draining later output without holding it
      resolveUrl(JSON.parse(line).data.url);
    };
    child.stdout.on("data", onData);
    child.on("exit", (code) => fail(new Error(`visp ui exited ${code}`)));
  });
  return { child, announced };
}

// Linear interpolation between order statistics; with few trials p90 sits near the
// maximum, so the maximum is reported alongside it.
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => {
    const at = (s.length - 1) * p;
    const lo = Math.floor(at);
    return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (at - lo);
  };
  return { n: s.length, min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};
const round = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v) : v)));

/** Waits until the selector count holds steady above zero; gives up after 30 s. */
async function settle(page, selector) {
  const deadline = Date.now() + 30_000;
  let last = -1;
  for (let stable = 0; stable < 10; ) {
    if (Date.now() > deadline) throw new Error(`${selector} did not settle (last count ${last})`);
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

// Records the first time a live change shows: a run mark absent from the baseline, or
// the marker text. Only the nodes each mutation touches are inspected, so the watcher
// adds little work to the re-render it times, and it stops looking once it has seen it.
const liveWatchScript = (selector) => {
  window.__watch = null;
  window.__seenAt = null;
  const shows = (node, watch) => {
    if (watch.marker) return node.textContent?.includes(watch.marker) ?? false;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const marks = node.matches(selector) ? [node] : [];
    marks.push(...node.querySelectorAll(selector));
    return marks.some((e) => !watch.baseline.has(e.dataset.key));
  };
  new MutationObserver((records) => {
    const watch = window.__watch;
    if (!watch || window.__seenAt !== null) return;
    for (const r of records) {
      const nodes = r.type === "childList" ? r.addedNodes : [r.target];
      for (const node of nodes) {
        if (shows(node, watch)) {
          window.__seenAt = Date.now();
          return;
        }
      }
    }
  }).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-key"],
  });
};

async function main() {
  const results = { fixture, firstRender: {}, live: {} };
  let child;
  let browser;
  try {
    rmSync(project, { recursive: true, force: true });
    cpSync(fixture, project, { recursive: true });
    const feature = readdirSync(join(project, ".visp/features"))[0];
    Object.assign(results, { feature, executionsInState: executions(feature) });
    const server = startServer();
    child = server.child;
    const url = await server.announced;
    const origin = new URL(url).origin;
    browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});

    // Sign in once; later contexts reuse the cookie with a cold HTTP cache.
    const signIn = await browser.newContext();
    const page0 = await signIn.newPage();
    await page0.goto(url);
    await page0.waitForFunction(() => location.hash === "#/");
    const cookies = await signIn.cookies();

    // Untimed warm-up: how many marks and run rows the fully loaded page shows.
    const route = (tab) => `${origin}/#/f/${encodeURIComponent(feature)}/${tab}`;
    await page0.goto(route("now"));
    const counts = { marks: await settle(page0, MARK) };
    counts.checks = await page0.evaluate(() => document.querySelectorAll('[data-key^="check:"]').length);
    await page0.goto(route("runs"));
    counts.runRows = await settle(page0, '[data-key^="run:"]');
    results.counts = counts;
    await signIn.close();

    const targets = [
      ["now", MARK, counts.marks],
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

    if (live) results.live = await liveTrials(browser, cookies, route, counts, feature);
  } finally {
    await browser?.close();
    child?.kill("SIGINT");
    writeFileSync(outFile, `${JSON.stringify(results, null, 1)}\n`);
    rmSync(project, { recursive: true, force: true });
  }
}

/** Oldest and newest mtime under .visp written since `since`. */
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

async function liveTrials(browser, cookies, route, counts, feature) {
  const out = {};
  for (const rate of LIVE_RATES) {
    const context = await browser.newContext();
    await context.addCookies(cookies);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    const sse = [];
    await cdp.send("Network.enable");
    // Only changes naming the feature: the source edit before `verify` raises a
    // project-wide ("*") change of its own.
    cdp.on("Network.eventSourceMessageReceived", (e) => {
      if (e.eventName === "change" && JSON.parse(e.data).features?.includes(feature)) sse.push(Date.now());
    });
    await page.addInitScript(liveWatchScript, MARK);
    await page.goto(route("now"));
    await page.waitForFunction(({ sel, n }) => document.querySelectorAll(sel).length >= n, {
      sel: MARK,
      n: counts.marks,
    });
    await page.waitForTimeout(2000);

    const kinds = {
      // visp verify records a new execution: a new mark in the thread.
      verify: async (k) => {
        await page.evaluate((sel) => {
          window.__seenAt = null;
          window.__watch = { baseline: new Set([...document.querySelectorAll(sel)].map((e) => e.dataset.key)) };
        }, MARK);
        writeFileSync(join(project, "src/m20.mjs"), `export const value = () => 20; // live ${rate}-${k}\n`);
        const start = Date.now();
        await visp(["verify", "--task", "T020"]);
        return { start, exit: Date.now() };
      },
      // visp brief --patch adds a decision shown on the Now page.
      brief: async (k) => {
        const marker = `Live marker ${rate}-${k}`;
        await page.evaluate((m) => {
          window.__seenAt = null;
          window.__watch = { marker: m };
        }, marker);
        const start = Date.now();
        await visp(
          ["brief", "--patch", "-", "--reason", marker],
          JSON.stringify({ decisions: [{ statement: marker, rationale: "live update trial" }] }),
        );
        return { start, exit: Date.now() };
      },
    };
    for (const [kind, act] of Object.entries(kinds)) {
      const fromWrite = [];
      const fromExit = [];
      const sseFromWrite = [];
      const missed = [];
      for (let k = 0; k < TRIALS; k++) {
        sse.length = 0;
        const { start, exit } = await act(k);
        const writes = writesSince(start);
        const at = await page
          .waitForFunction(() => window.__seenAt, null, { timeout: 15_000, polling: 100 })
          .then((handle) => handle.jsonValue())
          .catch(() => null);
        await page.evaluate(() => (window.__watch = null));
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
