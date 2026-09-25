import { expect, it } from "vitest";
import { codexExecCriticHost } from "../../../../src/workflow/product/critic-exec.js";

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
