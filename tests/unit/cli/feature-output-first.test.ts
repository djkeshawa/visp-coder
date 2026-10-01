import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type IndependentTester,
  inlineTests,
  readTestsRecord,
  saveTestsRecord,
  type TestsStarter,
} from "../../../src/workflow/product/independent-tests.js";
import { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson, watchStdout } from "./support/cli.js";

// The real starter runs Codex; the command's own flow is what is under test.
const fake = vi.hoisted(() => ({ starter: undefined as TestsStarter | undefined }));
vi.mock("../../../src/workflow/product/independent-tests.js", async (original) => ({
  ...(await original<typeof import("../../../src/workflow/product/independent-tests.js")>()),
  configuredTestsStarter: () => fake.starter,
}));

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  fake.starter = undefined;
  await workspace?.destroy();
  workspace = undefined;
});

const REQUEST = "Return two from the public module.\nKeep the module name.";
const FAILS_FIRST = `import assert from "node:assert/strict";
try {
  const { value } = await import("../../src/value.mjs");
  assert.equal(typeof value, "number");
  assert.ok(Number.isInteger(value));
  assert.equal(value, 2);
} catch (error) {
  console.log(\`FAIL: value: \${String(error?.message ?? error).replace(/\\s+/g, " ")}\`);
  process.exitCode = 1;
}
`;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function launched() {
  const created = await TestWorkspace.create(
    { "src/value.mjs": "export const value = 1;\n" },
    { critic: true },
  );
  workspace = created;
  const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
  config.critic = { ...config.critic, harness: "codex", launch: "codex-exec", mode: "auto" };
  // Recalling earlier requests would run a real Codex model call.
  config.memory = { ...config.memory, enabled: false };
  await created.write("visp.yml", stringify(config));
  await created.installFoundation();
  created.commit("install foundation");
  return created;
}

/** A tester that takes `ms` and reports when it started and ended. */
function slowTester(ms: number, times: { start?: number; end?: number }): IndependentTester {
  return async () => {
    times.start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    times.end = Date.now();
    return {
      file: { name: "value.test.mjs", content: FAILS_FIRST },
      tests: [{ name: "value", quote: "Return two" }],
      notes: "",
    };
  };
}

it("prints the feature while the tester runs, then waits for it in this process", async () => {
  const created = await launched();
  const times: { start?: number; end?: number } = {};
  fake.starter = inlineTests(slowTester(2500, times));
  let firstStdout: number | undefined;
  let running: string | undefined;
  const state = await created.state();
  const stop = watchStdout(() => {
    if (firstStdout !== undefined) return;
    firstStdout = Date.now();
    void readdir(join(created.root, ".visp/features")).then(async ([feature]) => {
      const record = await readTestsRecord(state, feature ?? "");
      running = record.ok ? record.value?.status : "unreadable";
    });
  });
  let result: Awaited<ReturnType<typeof runCli>>;
  try {
    result = await runCli(created.root, "feature", "Two", "--source-brief", REQUEST);
  } finally {
    stop();
  }
  const finished = Date.now();
  expect(result.exitCode, result.stderr).toBe(0);
  // Output first: it appears before the tester ends and a running record exists by then.
  expect(firstStdout).toBeDefined();
  expect(times.end).toBeDefined();
  expect((firstStdout ?? 0) + 1000).toBeLessThan(times.end ?? 0);
  expect(running).toBe("running");
  // The process only ends once the tester has, and its result is recorded.
  expect(finished).toBeGreaterThanOrEqual(times.end ?? Infinity);
  const [feature] = await readdir(join(created.root, ".visp/features"));
  const record = await readTestsRecord(await created.state(), feature ?? "");
  expect(record.ok && record.value?.status).toBe("pinned");
  expect(result.stdout).toMatch(/^feature: \{/);
  expect(result.stdout).toContain(
    `Note: Run visp work --feature ${feature} now; this command keeps running only to write VISP's acceptance tests — leave it running and do not run visp feature again.`,
  );
  expect(result.stderr).toContain("visp feature: recording the request takes up to 30 s");
});

it("prints one envelope for --json and no progress line, and keeps a failing tester out of the exit code", async () => {
  const created = await launched();
  const pending = deferred();
  fake.starter = inlineTests(async () => {
    await pending.promise;
    throw new Error("The tester could not run");
  });
  const stop = watchStdout(() => pending.resolve());
  const json = await runJson<{ brief: { feature: string }; testsNote?: string }>(
    created.root,
    "feature",
    "Two",
    "--source-brief",
    REQUEST,
  ).finally(() => {
    stop();
    pending.resolve();
  });
  expect(json.exitCode, json.stderr).toBe(0);
  expect(json.envelope.ok).toBe(true);
  expect(json.stderr).not.toContain("recording the request");
  const feature = json.envelope.data?.brief.feature ?? "";
  expect(json.envelope.data?.testsNote).toBe(
    `Run visp work --feature ${feature} now; this command keeps running only to write VISP's acceptance tests — leave it running and do not run visp feature again.`,
  );
  const record = await readTestsRecord(await created.state(), feature);
  expect(record.ok && record.value).toMatchObject({
    status: "failed",
    reason: expect.stringContaining("could not run"),
  });
});

it("authorizes work and routes next while feature's tester keeps running, then requires its pinned tests", async () => {
  const created = await launched();
  await created.write(
    "test/value.test.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value, 3);\n",
  );
  created.commit("declare worker check");
  const pending = deferred();
  const testerEntered = deferred();
  const output = deferred<string>();
  let calls = 0;
  let sourceRoot = "";
  fake.starter = inlineTests(async (request) => {
    calls += 1;
    sourceRoot = request.sourceRoot ?? request.root;
    testerEntered.resolve();
    await pending.promise;
    return {
      file: { name: "value.test.mjs", content: FAILS_FIRST },
      tests: [{ name: "value", quote: "Return two" }],
      notes: "",
    };
  });
  const stop = watchStdout((text) => {
    if (text.startsWith("feature: ")) output.resolve(text);
  });
  let finished = false;
  const featureCall = runCli(created.root, "feature", "Two", "--source-brief", REQUEST).then(
    (result) => {
      finished = true;
      return result;
    },
  );
  let feature = "";
  try {
    const text = await output.promise;
    stop();
    await testerEntered.promise;
    feature = JSON.parse(text.split("\n")[0]?.slice("feature: ".length) ?? "{}").feature;
    const next = await runJson<{ action: string; command: string }>(created.root, "next");
    expect(next.envelope.data).toMatchObject({
      action: "understand",
      command: `visp work --feature ${feature} --check "<command that runs your tests>"`,
    });
    const work = await runJson<{
      mayEdit: boolean;
      scope: { allowed: string[] };
      independentTests: { status: string };
    }>(created.root, "work", "--feature", feature, "--check", "node --test test/value.test.mjs");
    expect(work.exitCode, work.stderr).toBe(0);
    expect(work.envelope.data).toMatchObject({
      mayEdit: true,
      scope: { allowed: ["**"] },
      independentTests: { status: "running" },
    });
    const working = await runJson<{ action: string; mayEdit: boolean }>(created.root, "next");
    expect(working.envelope.data).toMatchObject({ action: "implement", mayEdit: true });
    expect(finished).toBe(false);
    expect(calls).toBe(1);
    expect(sourceRoot).not.toBe(created.root);
    await created.write("src/value.mjs", "export const value = 3;\n");
    expect(await readFile(join(sourceRoot, "src/value.mjs"), "utf8")).toContain("value = 1");
  } finally {
    stop();
    pending.resolve();
    await featureCall;
  }
  expect(await readTestsRecord(await created.state(), feature)).toMatchObject({
    ok: true,
    value: { status: "pinned", baseline: { exitCode: 1 } },
  });
  const done = await runJson<{ closed: boolean; executions: { check: string; status: string }[] }>(
    created.root,
    "done",
    "--feature",
    feature,
  );
  expect(done.envelope.data?.closed).toBe(false);
  expect(done.envelope.data?.executions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ check: "C001", status: "passed" }),
      expect.objectContaining({ check: "PINNED_1", status: "failed" }),
    ]),
  );
  const accept = await runJson(created.root, "accept", "--feature", feature);
  expect(accept.exitCode).toBe(1);
  expect(accept.envelope.ok).toBe(false);
});

it("says nothing about a tester when VISP launches none", async () => {
  const created = await launched();
  fake.starter = undefined;
  const result = await runCli(created.root, "feature", "Two", "--source-brief", REQUEST);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^feature: \{/);
  expect(result.stdout).not.toContain("keeps running only to write");
});

it("returns the earlier feature for a repeat and never starts a second tester", async () => {
  const created = await launched();
  const times: { start?: number; end?: number } = {};
  let calls = 0;
  const tester = slowTester(200, times);
  fake.starter = inlineTests(async (request) => {
    calls += 1;
    return tester(request);
  });
  const first = await runCli(created.root, "feature", "Two", "--source-brief", REQUEST);
  expect(first.exitCode, first.stderr).toBe(0);
  const second = await runCli(created.root, "feature", "Two", "--source-brief", REQUEST);
  expect(second.exitCode, second.stderr).toBe(0);
  expect(second.stdout).toContain("already records this request");
  expect(second.stdout).not.toContain("keeps running only to write");
  expect(calls).toBe(1);
  expect(await readdir(join(created.root, ".visp/features"))).toHaveLength(1);
});

it("does not claim a tester this process did not start", async () => {
  const created = await launched();
  fake.starter = undefined;
  const first = await runJson<{ brief: { feature: string } }>(
    created.root,
    "feature",
    "Two",
    "--source-brief",
    REQUEST,
  );
  const feature = first.envelope.data?.brief.feature ?? "";
  // Another process's tester is running for this feature.
  const running = {
    version: 1 as const,
    status: "running" as const,
    startedAt: new Date().toISOString(),
    model: "gpt-5",
  };
  expect((await saveTestsRecord(await created.state(), feature, running, undefined)).ok).toBe(true);
  let calls = 0;
  fake.starter = inlineTests(async () => {
    calls += 1;
    throw new Error("must not start");
  });
  const repeat = await runCli(created.root, "feature", "Two", "--source-brief", REQUEST);
  expect(repeat.exitCode, repeat.stderr).toBe(0);
  expect(repeat.stdout).toContain("already records this request");
  expect(repeat.stdout).not.toContain("keeps running only to write");
  expect(calls).toBe(0);
});
