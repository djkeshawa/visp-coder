import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  codexExecCriticHost,
  runCodexStructured,
} from "../../../../src/workflow/product/critic-exec.js";

const config = {
  harness: "codex" as const,
  model: "gpt-5.6-sol",
  reasoningEffort: "high" as const,
  maxCalls: 2,
  timeoutMs: 180_000,
  maxImageBytes: 4_194_304,
  requiresImages: false,
  signal: new AbortController().signal,
};

it("reports a reviewer without network as unavailable before any call is reserved", async () => {
  const host = codexExecCriticHost({
    root: process.cwd(),
    executable: process.execPath,
    lookup: async () => {
      throw new Error("getaddrinfo EAI_AGAIN chatgpt.com");
    },
  });
  const report = await host.inspect?.(config);
  expect(report).toMatchObject({ unavailable: expect.stringContaining("sandbox escalation") });
});

it("reports the configured reviewer when it can reach its model", async () => {
  const host = codexExecCriticHost({
    root: process.cwd(),
    executable: process.execPath,
    lookup: async () => undefined,
  });
  expect(await host.inspect?.(config)).toMatchObject({
    harness: "codex",
    model: "gpt-5.6-sol",
    readOnly: true,
    delegationAllowed: true,
  });
});

// Inside a host sandbox the operator's Codex home is read-only, and codex exec must write
// to its home even with --ephemeral. The reviewer gets a private writable copy.
it("runs the reviewer with a private writable Codex home that keeps its sign-in", async () => {
  const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const operatorHome = await mkdtemp(join(tmpdir(), "visp-codex-home-"));
  await writeFile(join(operatorHome, "auth.json"), '{"token":"signed-in"}');
  const fake = join(operatorHome, "fake-codex.mjs");
  await writeFile(
    fake,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli test"); process.exit(0); }
const home = process.env.CODEX_HOME;
writeFileSync(home + "/session.log", "writable");
const auth = readFileSync(home + "/auth.json", "utf8");
const out = args[args.indexOf("--output-last-message") + 1];
writeFileSync(out, JSON.stringify({ home, auth }));
`,
  );
  await chmod(fake, 0o755);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = operatorHome;
  try {
    const host = codexExecCriticHost({
      root: process.cwd(),
      executable: fake,
      lookup: async () => undefined,
    });
    const packet = {
      current: { images: [] },
      responseSchema: {},
    } as unknown as Parameters<typeof host.review>[0];
    const result = await host.review(packet, { ...config, signal: new AbortController().signal });
    const response = result.response as { home: string; auth: string };
    expect(response.auth).toBe('{"token":"signed-in"}');
    expect(response.home).not.toBe(operatorHome);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

// The reviewer may search the web, and every query is logged for the human reviewer.
it("enables web search only when configured and logs every query", async () => {
  const { mkdtemp, mkdir, writeFile, chmod, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "visp-reviewer-web-"));
  await mkdir(join(root, ".visp/features/001-demo"), { recursive: true });
  const fake = join(root, "fake-codex.mjs");
  await writeFile(
    fake,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli test"); process.exit(0); }
const web = args.includes('web_search="live"');
if (web) console.log(JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "RFC 9110 405 Allow header" } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "rg confirm" } }));
writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ web }));
`,
  );
  await chmod(fake, 0o755);
  const packet = {
    current: { images: [] },
    responseSchema: {},
    selection: { feature: "001-demo", task: "T001" },
  } as unknown as Parameters<ReturnType<typeof codexExecCriticHost>["review"]>[0];
  const signal = new AbortController().signal;
  for (const webSearch of [false, true]) {
    const host = codexExecCriticHost({ root, executable: fake, webSearch });
    const result = await host.review(packet, { ...config, signal });
    expect(result.response).toEqual({ web: webSearch });
  }
  const log = (
    await readFile(join(root, ".visp/features/001-demo/reviewer-activity.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toEqual([
    expect.objectContaining({ task: "T001", webSearches: [], commands: ["rg confirm"] }),
    expect.objectContaining({ webSearches: ["RFC 9110 405 Allow header"] }),
  ]);
});

// Each test gets its own temporary directory, so leftovers are visible and other runs'
// directories are never touched.
const sandboxes: string[] = [];
let previousTmpdir: string | undefined;

beforeEach(async () => {
  previousTmpdir = process.env.TMPDIR;
  const sandbox = await mkdtemp(join(tmpdir(), "visp-critic-test-"));
  sandboxes.push(sandbox);
  process.env.TMPDIR = sandbox;
});

afterEach(async () => {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  await Promise.all(sandboxes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const emptyPacket = { current: { images: [] }, responseSchema: {} } as unknown as Parameters<
  ReturnType<typeof codexExecCriticHost>["review"]
>[0];

async function fakeCodex(body: string): Promise<{ fake: string; work: string }> {
  const work = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const fake = join(work, "fake-codex.mjs");
  await writeFile(
    fake,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli test"); process.exit(0); }
${body}`,
  );
  await chmod(fake, 0o755);
  return { fake, work };
}

async function untilExists(path: string) {
  for (let attempt = 0; attempt < 200 && !existsSync(path); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(existsSync(path)).toBe(true);
}

async function heartbeatStops(path: string) {
  let last = await readFile(path, "utf8");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = await readFile(path, "utf8");
    if (now === last) return true;
    last = now;
  }
  return false;
}

it("ends Codex's descendants and removes its sign-in copy when the review is aborted", async () => {
  const { fake, work } = await fakeCodex(`
import { spawn } from "node:child_process";
const dir = process.env.VISP_FAKE_DIR;
writeFileSync(dir + "/home", process.env.CODEX_HOME);
// A grandchild that keeps writing; only a group kill stops it.
spawn(process.execPath, ["-e", "const {writeFileSync}=require('node:fs');let n=0;setInterval(()=>writeFileSync(process.argv[1],String(n++)),50)", dir + "/heartbeat"], { stdio: "ignore" });
setInterval(() => undefined, 1000);
`);
  process.env.VISP_FAKE_DIR = work;
  try {
    const host = codexExecCriticHost({
      root: process.cwd(),
      executable: fake,
      lookup: async () => undefined,
    });
    const controller = new AbortController();
    const review = host.review(emptyPacket, { ...config, signal: controller.signal });
    const settled = review.then(
      () => "resolved",
      () => "rejected",
    );
    await untilExists(join(work, "heartbeat"));
    const home = await readFile(join(work, "home"), "utf8");
    expect(existsSync(home)).toBe(true);
    controller.abort();
    expect(await settled).toBe("rejected");
    expect(await heartbeatStops(join(work, "heartbeat"))).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(existsSync(join(home, ".."))).toBe(false);
  } finally {
    delete process.env.VISP_FAKE_DIR;
  }
}, 30_000);

// The tester's directory lives for the whole session, so the sign-in copy must go as soon
// as Codex has ended, not when the caller removes its directory.
it("removes the sign-in copy but not the caller's directory when Codex exits non-zero", async () => {
  const { fake, work } = await fakeCodex(`
writeFileSync(process.env.VISP_FAKE_DIR + "/home", process.env.CODEX_HOME);
console.error("boom");
process.exit(3);
`);
  const directory = await mkdtemp(join(tmpdir(), "visp-caller-"));
  process.env.VISP_FAKE_DIR = work;
  try {
    await expect(
      runCodexStructured({
        executable: fake,
        root: process.cwd(),
        directory,
        model: "gpt-5.6-sol",
        schema: {},
        prompt: "hello",
      }),
    ).rejects.toThrow(/exited 3.*boom/);
    const home = await readFile(join(work, "home"), "utf8");
    expect(home).toBe(join(directory, "codex-home"));
    expect(existsSync(home)).toBe(false);
    expect(existsSync(directory)).toBe(true);
  } finally {
    delete process.env.VISP_FAKE_DIR;
  }
});

it("removes abandoned reviewer directories at the start of a review and keeps fresh ones", async () => {
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  const stale = ["visp-critic-aB3dE9", "visp-review-Zy81xQ"];
  for (const name of stale) {
    await mkdir(join(tmpdir(), name, "codex-home"), { recursive: true });
    await writeFile(join(tmpdir(), name, "codex-home", "auth.json"), "{}");
    await utimes(join(tmpdir(), name), old, old);
  }
  await mkdir(join(tmpdir(), "visp-critic-fReSh1"));
  // Named directories that only share a prefix are not review temp dirs.
  const named = ["visp-review-calibration-inputs", "visp-critic-home-x"];
  for (const name of named) {
    await mkdir(join(tmpdir(), name));
    await utimes(join(tmpdir(), name), old, old);
  }
  const { fake } = await fakeCodex(
    'writeFileSync(args[args.indexOf("--output-last-message") + 1], "{}");',
  );
  const host = codexExecCriticHost({
    root: process.cwd(),
    executable: fake,
    lookup: async () => undefined,
  });
  await host.review(emptyPacket, config);
  for (const name of stale) expect(existsSync(join(tmpdir(), name))).toBe(false);
  expect(existsSync(join(tmpdir(), "visp-critic-fReSh1"))).toBe(true);
  for (const name of named) expect(existsSync(join(tmpdir(), name))).toBe(true);
});
