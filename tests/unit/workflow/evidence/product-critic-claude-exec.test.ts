import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchesReviewer } from "../../../../src/config/critic.js";
import {
  claudeExecCriticHost,
  configuredCriticLauncher,
} from "../../../../src/workflow/product/critic-exec.js";
import {
  configuredReviewStarter,
  reviewWaitMs,
} from "../../../../src/workflow/product/done-review.js";
import { reviewerRules } from "../../../../src/workflow/product/pinned-dispute-model.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";

const work: string[] = [];
afterEach(async () => {
  delete process.env.VISP_FAKE_DIR;
  await Promise.all(work.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A stand-in `claude` that records how it was called and prints `reply` as its JSON result. */
async function fakeClaude(reply: string, exitCode = 0, loggedIn = true) {
  const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
  work.push(dir);
  const fake = join(dir, "fake-claude.mjs");
  await writeFile(
    fake,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: ${loggedIn} })); process.exit(0); }
const stdin = readFileSync(0, "utf8");
const addDir = args[args.indexOf("--add-dir") + 1];
writeFileSync(process.env.VISP_FAKE_DIR + "/call.json", JSON.stringify({ args, cwd: process.cwd(), stdin, addDirExisted: !!addDir }));
process.stdout.write(${JSON.stringify(reply)});
process.exit(${exitCode});
`,
  );
  await chmod(fake, 0o755);
  process.env.VISP_FAKE_DIR = dir;
  return { fake, dir };
}

const config = {
  harness: "claude-code" as const,
  model: "claude-sonnet-5-5",
  reasoningEffort: "medium" as const,
  transport: "native" as const,
  maxCalls: 3,
  timeoutMs: 5000,
  maxImageBytes: 4 * 1024 * 1024,
};
const packet = {
  current: { images: [], question: "Does the change meet the request?" },
  responseSchema: { type: "object", properties: { review: { type: "object" } } },
} as unknown as Parameters<ReturnType<typeof claudeExecCriticHost>["review"]>[0];
const reachable = async () => true;

it("reports why a Claude reviewer cannot run before any call is spent", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-claude-root-"));
  work.push(root);
  const wrongHarness = claudeExecCriticHost({ root, executable: process.execPath });
  expect(await wrongHarness.inspect?.({ ...config, harness: "codex" } as never)).toEqual({
    unavailable: "critic.launch: claude-exec requires critic.harness: claude-code",
  });
  const missing = claudeExecCriticHost({ root, executable: join(root, "no-such-claude") });
  expect(await missing.inspect?.(config as never)).toMatchObject({
    unavailable: expect.stringContaining("Claude Code CLI is not runnable"),
  });
  const { fake, dir } = await fakeClaude("{}");
  const offline = claudeExecCriticHost({
    root,
    executable: fake,
    lookup: () => Promise.reject(new Error("offline")),
  });
  expect(await offline.inspect?.(config as never)).toMatchObject({
    unavailable: expect.stringContaining("cannot reach its model"),
  });
  const signedOut = await fakeClaude("{}", 0, false);
  expect(
    await claudeExecCriticHost({ root, executable: signedOut.fake, lookup: reachable }).inspect?.(
      config as never,
    ),
  ).toMatchObject({ unavailable: expect.stringContaining("not signed in") });
  process.env.VISP_FAKE_DIR = dir;
  const online = claudeExecCriticHost({ root, executable: fake, lookup: reachable });
  expect(await online.inspect?.(config as never)).toEqual({
    harness: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
    freshContext: true,
    images: true,
    readOnly: true,
    delegationAllowed: true,
  });
});

it("runs one read-only, settings-free claude -p in the project with the packet's schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-claude-root-"));
  work.push(root);
  const response = { review: { summary: "fine" } };
  const { fake, dir } = await fakeClaude(
    JSON.stringify({ type: "result", is_error: false, result: "{}", structured_output: response }),
  );
  const host = claudeExecCriticHost({ root, executable: fake, lookup: reachable });
  const reviewed = await host.review(packet, config as never);
  expect(reviewed).toEqual({
    model: "claude-sonnet-5-5",
    reasoningEffort: "medium",
    context: "fresh",
    response,
  });
  const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
  expect(call.cwd).toBe(root);
  const args: string[] = call.args;
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(args[0]).toBe("-p");
  expect(value("--model")).toBe("claude-sonnet-5-5");
  expect(value("--effort")).toBe("medium");
  expect(value("--output-format")).toBe("json");
  expect(JSON.parse(value("--json-schema") ?? "")).toEqual(packet.responseSchema);
  expect(value("--tools")).toBe("Read,Grep,Glob");
  expect(value("--permission-mode")).toBe("dontAsk");
  expect(value("--permission-prompts")).toBe("none");
  expect(args).toEqual(
    expect.arrayContaining([
      "--restricted",
      "--safe-mode",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]),
  );
  expect(args).not.toContain("--dangerously-skip-permissions");
  // The packet travels on stdin with the reviewer instructions; its image directory is removed.
  expect(call.stdin).toContain("You are an independent reviewer");
  expect(call.stdin).toContain("Does the change meet the request?");
  expect(existsSync(value("--add-dir") ?? "")).toBe(false);
});

it("fails the call when claude reports an error or returns no structured result", async () => {
  const root = await mkdtemp(join(tmpdir(), "visp-claude-root-"));
  work.push(root);
  const notLoggedIn = await fakeClaude(
    JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }),
  );
  await expect(
    claudeExecCriticHost({ root, executable: notLoggedIn.fake, lookup: reachable }).review(
      packet,
      config as never,
    ),
  ).rejects.toThrow("Not logged in");
  const crashed = await fakeClaude("", 2);
  await expect(
    claudeExecCriticHost({ root, executable: crashed.fake, lookup: reachable }).review(
      packet,
      config as never,
    ),
  ).rejects.toThrow("exited 2");
  const notLoggedInCall = JSON.parse(await readFile(join(notLoggedIn.dir, "call.json"), "utf8"));
  const imageDirectory = notLoggedInCall.args[notLoggedInCall.args.indexOf("--add-dir") + 1];
  expect(existsSync(imageDirectory)).toBe(false);
  const nullResult = await fakeClaude(
    JSON.stringify({ type: "result", is_error: false, result: "", structured_output: null }),
  );
  await expect(
    claudeExecCriticHost({ root, executable: nullResult.fake, lookup: reachable }).review(
      packet,
      config as never,
    ),
  ).rejects.toThrow("no structured result");
  const unstructured = await fakeClaude(
    JSON.stringify({ type: "result", is_error: false, result: "plain text" }),
  );
  await expect(
    claudeExecCriticHost({ root, executable: unstructured.fake, lookup: reachable }).review(
      packet,
      config as never,
    ),
  ).rejects.toThrow("no structured result");
});

it("treats claude-exec as a VISP-launched reviewer for waits, disputes and launcher selection", () => {
  const workspace = (launch?: string, harness = "codex") =>
    ({
      config: { harness, critic: launch ? { launch, harness: "claude-code" } : undefined },
      paths: { root: "/project" },
    }) as unknown as WorkspaceState;
  expect(launchesReviewer({ launch: "claude-exec" })).toBe(true);
  expect(launchesReviewer({ launch: "codex-exec" })).toBe(true);
  expect(launchesReviewer({ launch: "host" })).toBe(false);
  expect(launchesReviewer(undefined)).toBe(false);
  expect(reviewWaitMs(workspace("claude-exec"), "cli")).toBeGreaterThan(0);
  expect(reviewWaitMs(workspace("host"), "cli")).toBe(0);
  expect(reviewerRules(workspace("claude-exec"))).toBe(true);
  expect(configuredCriticLauncher(workspace("host"))).toBeUndefined();
});

it("selects the Claude launcher for claude-exec and the Codex one for codex-exec", async () => {
  const workspace = (launch: string) =>
    ({
      config: { harness: "codex", critic: { launch } },
      paths: { root: "/project" },
    }) as unknown as WorkspaceState;
  const codexConfig = { ...config, harness: "codex" } as never;
  expect(await configuredCriticLauncher(workspace("claude-exec"))?.inspect?.(codexConfig)).toEqual({
    unavailable: "critic.launch: claude-exec requires critic.harness: claude-code",
  });
  expect(
    await configuredCriticLauncher(workspace("codex-exec"))?.inspect?.(config as never),
  ).toEqual({ unavailable: "critic.launch: codex-exec requires critic.harness: codex" });
  expect(configuredReviewStarter(workspace("claude-exec"), "cli")).toBeDefined();
  expect(configuredReviewStarter(workspace("host"), "cli")).toBeUndefined();
});
