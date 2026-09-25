import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDocument } from "yaml";

// The host capability report below is a controlled fixture. No model is invoked.
const archive = process.argv[2];
assert(
  archive && isAbsolute(archive),
  "Usage: node scripts/upgrade-published-spending.mjs /absolute/path/to/visp-coder-0.4.0-beta.3.tgz",
);
const repository = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "visp-published-spending-"));
const root = join(scratch, "project");
let complete = false;
let oldClient;
let currentClient;
const oldMcpRefusals = [];

function run(binary, args, cwd, env = process.env, input) {
  return execFileSync(binary, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function cli(binary, env, args, input, allowFailure = false) {
  let output;
  try {
    output = run(binary, ["--project", root, ...args, "--json"], root, env, input);
  } catch (error) {
    if (!allowFailure || !error.stdout) throw error;
    output = String(error.stdout);
  }
  const result = JSON.parse(output);
  if (!allowFailure) assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

try {
  const provenance = JSON.parse(
    run(
      process.execPath,
      [join(repository, "scripts/verify-published-predecessor.mjs"), "0.4.0-beta.3", archive],
      repository,
    ),
  );
  await mkdir(root);
  run("git", ["init", "-q", "-b", "main"], root);
  run("git", ["config", "user.name", "Published Upgrade Fixture"], root);
  run("git", ["config", "user.email", "published-upgrade@example.test"], root);
  const oldPrefix = join(scratch, "old");
  run("npm", ["install", "--global", "--ignore-scripts", "--prefix", oldPrefix, archive], repository);
  const oldBin = join(oldPrefix, "bin");
  const oldCli = join(oldBin, "visp");
  const oldEnv = { ...process.env, PATH: `${oldBin}${delimiter}${process.env.PATH ?? ""}` };
  assert.equal(run(oldCli, ["--version"], repository, oldEnv).trim(), "0.4.0-beta.3");

  await writeFile(join(root, "value.mjs"), "export const value = 1;\n");
  await writeFile(
    join(root, "value.test.mjs"),
    "import assert from 'node:assert/strict';import {value} from './value.mjs';assert.equal(value,2);\n",
  );
  const prior = (args, input, allowFailure) => cli(oldCli, oldEnv, args, input, allowFailure);
  prior(["init", "--harness", "generic"]);
  prior(["install", "--hooks", "git", "--no-mcp"]);
  run("git", ["add", "-A"], root, oldEnv);
  run("git", ["commit", "-qm", "published predecessor baseline"], root, oldEnv);
  const started = prior(["feature", "Return two"]).data.brief;
  const brief = {
    ...started,
    outcomes: [{ id: "O001", kind: "functional", statement: "Public value equals two", priority: "must", provenance: "user-stated" }],
    checks: [{ id: "C001", command: [process.execPath, "value.test.mjs"], outcomes: ["O001"], files: ["value.mjs", "value.test.mjs"], environment: "node" }],
    slices: [{ id: "T001", goal: "Return two", outcomes: ["O001"], scope: { allowed: ["value.mjs"], expected: ["value.mjs"], forbidden: [] }, checks: ["C001"] }],
  };
  prior(["brief", "--from", "-", "--reason", "Define a reproducible failure"], JSON.stringify(brief));
  prior(["work", "--task", "T001"]);
  const failed = prior(["verify", "--task", "T001"], undefined, true);
  assert.equal(failed.data?.passed, false);
  prior(["critic", "--on", "--harness", "codex"]);
  const config = {
    harness: "codex",
    transport: "native",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    maxCalls: 2,
    timeoutMs: 180_000,
    maxImageBytes: 4 * 1024 * 1024,
  };
  prior(["critic", "--task", "T001", "--configure", "-"], JSON.stringify(config));
  const fixtureCapabilities = {
    harness: "codex",
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    freshContext: true,
    images: true,
    readOnly: true,
    delegationAllowed: true,
  };
  const prepared = prior(
    ["critic", "--task", "T001", "--source-only", "--prepare", "--capabilities", "-"],
    JSON.stringify(fixtureCapabilities),
  );
  const attempt = prepared.data?.attempt;
  assert.match(attempt, /^[a-f0-9-]{36}$/i);
  prior([
    "critic", "--task", "T001", "--attempt", attempt,
    "--failure-kind", "invocation-failed",
    "--failure", "Controlled transport interruption; invocation outcome unknown",
  ]);
  const historyDir = join(root, ".visp/features", brief.feature, "critic");
  const historyFiles = (await readdir(historyDir)).filter((name) => name.endsWith(".json"));
  assert.equal(historyFiles.length, 1);
  const historyPath = join(historyDir, historyFiles[0]);
  const originalHistory = await readFile(historyPath, "utf8");
  const oldHistory = JSON.parse(originalHistory);
  assert.equal(oldHistory.attempts.length, 1);
  assert.equal(oldHistory.attempts[0].id, attempt);
  assert.equal(oldHistory.attempts[0].status, "unavailable");
  const statePath = join(root, ".visp/features", brief.feature, "product-state.json");
  const originalState = await readFile(statePath, "utf8");
  oldClient = await connectMcp(oldCli, root, oldEnv);
  assert.equal(oldClient.getServerVersion()?.version, "0.4.0-beta.3");

  const configPath = join(root, "visp.yml");
  const originalConfig = await readFile(configPath, "utf8");
  const originalArchive = join(root, ".visp/upgrade-original");
  await mkdir(originalArchive, { recursive: true });
  await writeFile(join(originalArchive, "visp.yml"), originalConfig);
  const compatible = parseDocument(originalConfig);
  for (const key of ["ranking", "snippetCap", "maxSnippetLines", "includeSnippets", "maxRegionsPerFile"])
    compatible.deleteIn(["context", key]);
  for (const key of ["queryDepth", "queryResults"]) compatible.deleteIn(["graph", key]);
  for (const key of ["maxSourceFileLines", "maxSourceLineChars", "requireTests"])
    compatible.deleteIn(["workflow", key]);
  await writeFile(configPath, compatible.toString());

  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository),
  );
  assert(packed[0]?.filename);
  const candidatePrefix = join(scratch, "candidate");
  run(
    "npm",
    ["install", "--global", "--ignore-scripts", "--prefix", candidatePrefix, join(scratch, packed[0].filename)],
    repository,
  );
  const candidateBin = join(candidatePrefix, "bin");
  const candidateEnv = { ...process.env, PATH: `${candidateBin}${delimiter}${process.env.PATH ?? ""}` };
  const migrate = (operation) =>
    JSON.parse(run(join(candidateBin, "visp-migrate"), ["--project", root, operation], root, candidateEnv));
  const preview = migrate("preview");
  assert.equal(preview.ok, true);
  assert.equal(await readFile(historyPath, "utf8"), originalHistory);
  assert.equal(await readFile(statePath, "utf8"), originalState);
  const applied = migrate("apply");
  assert.equal(applied.ok, true);
  assert(applied.data?.changed > 0, "Historical spending must require an actual migration");
  assert.match(applied.data?.backup, /^\.visp\/migrations\/backups\/[a-f0-9]{64}\.json$/);
  const backup = JSON.parse(await readFile(join(root, applied.data.backup), "utf8"));
  const saved = new Map(
    backup.files.map(({ path, contentBase64 }) => [
      path,
      Buffer.from(contentBase64, "base64").toString("utf8"),
    ]),
  );
  assert.equal(saved.get(`.visp/features/${brief.feature}/critic/${historyFiles[0]}`), originalHistory);
  assert.equal(saved.get(`.visp/features/${brief.feature}/product-state.json`), originalState);
  assert.equal(saved.get(".visp/upgrade-original/visp.yml"), originalConfig);
  assert.equal(await readFile(historyPath, "utf8"), originalHistory);
  const budget = JSON.parse(
    await readFile(join(root, ".visp/features", brief.feature, "critic-budget.json"), "utf8"),
  );
  assert.equal(budget.maxCalls, config.maxCalls);
  assert.equal(budget.entries.length, 1);
  assert.equal(budget.entries[0].reservedMs, config.timeoutMs);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).criticBudgetVersion, 1);
  assert.equal(migrate("apply").data?.changed, 0);
  const protectedPaths = [
    statePath,
    historyPath,
    configPath,
    join(root, ".visp/features", brief.feature, "critic-budget.json"),
    join(root, ".visp/state/product-authorizations", `${brief.feature}.json`),
    join(root, ".visp/state/implement-allowed/T001.json"),
  ];
  await assertOldMcpRefusesUpgrade(oldClient, protectedPaths, oldMcpRefusals);

  const candidateCli = join(candidateBin, "visp");
  const current = (args) => cli(candidateCli, candidateEnv, args);
  current(["install", "--harness", "generic", "--hooks", "git", "--no-mcp"]);
  await assertOldMcpRefusesUpgrade(
    oldClient,
    protectedPaths,
    oldMcpRefusals,
    "after-current-install",
  );
  currentClient = await connectMcp(candidateCli, root, candidateEnv);
  assert.equal(
    currentClient.getServerVersion()?.version,
    JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version,
  );
  const restarted = await currentClient.callTool({ name: "visp_next", arguments: {} });
  assert.notEqual(restarted.isError, true, JSON.stringify(restarted));
  const identity = current(["guard", "--handshake"]).data?.runtime;
  assert.match(identity?.buildId, /^[a-f0-9]{16}$/);
  assert.equal(
    identity?.version,
    JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version,
  );
  assert.notEqual(identity.version, "0.4.0-beta.3");
  const status = current(["critic", "--task", "T001"]);
  assert.equal(status.data?.callsUsed, 1);
  assert.equal(status.data?.callsRemaining, 1);
  console.log(JSON.stringify({
    archiveSha256: provenance.sha256,
    oldVersion: "0.4.0-beta.3",
    candidateVersion: run(candidateCli, ["--version"], root, candidateEnv).trim(),
    candidateBuildId: identity.buildId,
    attempt,
    originalHistoryPreserved: true,
    rawBackupPreserved: true,
    reservedMs: budget.entries[0].reservedMs,
    callsUsed: status.data.callsUsed,
    callsRemaining: status.data.callsRemaining,
    oldMcpRefusals,
    restartedMcpRecovered: true,
    modelInvoked: false,
    capabilityReport: "controlled fixture; not observed host capability",
  }));
  complete = true;
} finally {
  await oldClient?.close();
  await currentClient?.close();
  if (complete) await rm(scratch, { recursive: true, force: true });
  else console.error(`Published-spending fixture retained for diagnosis: ${scratch}`);
}

async function connectMcp(binary, project, env) {
  const client = new Client({ name: "published-spending-upgrade", version: "1" });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["--project", project, "serve", "--mcp"],
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function assertOldMcpRefusesUpgrade(client, paths, refusals, phase = "after-migration") {
  const before = await Promise.all(paths.map(readOptional));
  for (const name of ["visp_work", "visp_done", "visp_accept"]) {
    const response = await client.callTool({
      name,
      arguments: name === "visp_accept" ? {} : { task: "T001" },
    });
    assert.equal(
      response.isError,
      true,
      `Old MCP must refuse upgraded ${name}: ${JSON.stringify(response)}`,
    );
    const code = response.structuredContent?.error?.code;
    assert.equal(
      code,
      "ARTIFACT_INVALID",
      `Old MCP must reject the upgraded state: ${JSON.stringify(response)}`,
    );
    refusals.push({ phase, tool: name, code });
    assert.deepEqual(
      await Promise.all(paths.map(readOptional)),
      before,
    );
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
