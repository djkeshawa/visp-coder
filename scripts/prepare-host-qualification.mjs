// Local browser evidence only: never reserve or invoke a critic from this script.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "visp-host-qualification-"));
const root = join(scratch, "project");
const bin = join(scratch, "bin");
await mkdir(root);
await mkdir(bin);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
await writeFile(
  join(bin, "visp"),
  `#!/bin/sh\nexport PATH=${quote(env.PATH)}\nexec ${quote(process.execPath)} ${quote(join(repository, "dist/cli.js"))} "$@"\n`,
  { mode: 0o755 },
);
function run(binary, args, input) {
  return execFileSync(binary, args, { cwd: root, env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
}
function cli(args, input, allowFailure = false) {
  let output;
  try { output = run(join(bin, "visp"), ["--project", root, ...args, "--json"], input); }
  catch (error) { if (!allowFailure || !error.stdout) throw error; output = String(error.stdout); }
  const result = JSON.parse(output);
  if (!allowFailure) assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
try {
  run("git", ["init", "-q", "-b", "main"]);
  run("git", ["config", "user.name", "Host Qualification"]);
  run("git", ["config", "user.email", "qualification@example.test"]);
  await writeFile(join(root, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Counter</title>
<style>body{font:24px system-ui;margin:48px;background:#f6f3ed;color:#182530}button{font:inherit;padding:20px;margin-right:24px}output{font-size:48px}</style>
<h1>Counter</h1><p>Each activation adds one.</p><button id="act">Increment</button><output id="result" aria-live="polite">0</output>
<script>let count=0;document.querySelector('#act').addEventListener('click',()=>{if(count>0)return;document.querySelector('#result').textContent=String(++count);});</script></html>`);
  cli(["init", "--harness", "generic"]);
  cli(["install", "--harness", "generic", "--hooks", "git", "--no-mcp"]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-qm", "qualification baseline"]);
  const started = cli(["feature", "Build a counter that increments for every pointer or keyboard activation and clearly displays its value."]).data.brief;
  const journey = {
    url: pathToFileURL(join(root, "index.html")).href,
    viewport: { width: 800, height: 600 },
    actions: [
      { kind: "click", selector: "#act", capture: true },
      { kind: "wait-for", selector: "#result", text: "1", timeoutMs: 600, capture: true },
      { kind: "click", selector: "#act", capture: true },
      { kind: "wait-for", selector: "#result", text: "2", timeoutMs: 600, capture: true },
    ],
  };
  const brief = { ...started,
    outcomes: [{ id: "O001", kind: "functional", statement: "Every activation increments the visible value", priority: "must", provenance: "user-stated" }],
    checks: [{ id: "C001", command: { kind: "browser-journey", journey }, outcomes: ["O001"], files: ["index.html"], environment: "browser" }],
    slices: [{ id: "T001", goal: "Implement the counter", outcomes: ["O001"], scope: { allowed: ["index.html"], expected: ["index.html"], forbidden: [] }, checks: ["C001"] }],
  };
  cli(["brief", "--from", "-", "--reason", "Define the observed behavior"], JSON.stringify(brief));
  cli(["work", "--task", "T001"]);
  const capture = cli(["capture", "--task", "T001", "--from", "-"], JSON.stringify(journey), true);
  assert.equal(capture.ok, true, JSON.stringify(capture));
  assert.equal(capture.data.status, "timed-out");
  assert.equal(capture.data.failure?.kind, "behavior");
  assert.equal(capture.data.failure?.actionIndex, 3);
  assert.match(capture.data.failure.message, /expected "2", observed "1"/);
  assert(capture.data.captures.length > 0);
  const config = { harness: "codex", transport: "native", model: "gpt-6-astra", reasoningEffort: "low", maxCalls: 1, timeoutMs: 180_000, maxImageBytes: 4 * 1024 * 1024 };
  cli(["critic", "--task", "T001", "--configure", "-"], JSON.stringify(config));
  const preflight = cli(["critic", "--task", "T001", "--preflight"]);
  assert.equal(preflight.data.ready, false);
  assert.equal(preflight.data.requiresImages, true);
  const status = cli(["critic", "--task", "T001"]);
  assert.equal(status.data.callsUsed, 0);
  const result = { root, environment: { PATH: env.PATH }, cli: join(bin, "visp"), feature: started.feature, config, capture: capture.data, preflight: preflight.data, status: status.data, modelInvoked: false };
  await writeFile(join(scratch, "preparation.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ preparation: join(scratch, "preparation.json"), root, callsUsed: 0, modelInvoked: false }));
} catch (error) {
  console.error(`Qualification fixture retained: ${scratch}`);
  throw error;
}
