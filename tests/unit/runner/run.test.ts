import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../../../src/core/hash.js";
import type { RunnerSpec } from "../../../src/runner/contracts.js";
import {
  evaluateRun,
  hashEvaluatorPolicy,
  inspectEvaluation,
} from "../../../src/runner/evaluator.js";
import { inspectRun, runExperiment } from "../../../src/runner/run.js";

let root: string;
let repo: string;
let executable: string;
let spec: RunnerSpec;
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "visp-runner-test-")));
  repo = join(root, "repository");
  execFileSync("git", ["init", "--quiet", repo]);
  git("config", "user.email", "runner@example.invalid");
  git("config", "user.name", "Runner test");
  await writeFile(join(repo, "app.txt"), "original\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  executable = join(root, "fake-host");
  const script = `#!${process.execPath}
import {appendFileSync,writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('fake 1.0'); process.exit(0); }
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>prompt+=x);
process.stdin.on('end',()=>{
 appendFileSync(${JSON.stringify(join(root, "host-turns.log"))}, 'turn\\n');
 if(prompt==='cost-only') {
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:'session-1',model:'small'}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,total_cost_usd:0.01}));
  return;
 }
 console.log(JSON.stringify({type:'thread.started',thread_id:'session-1'}));
 if(prompt==='hang') { setInterval(()=>{},1000); return; }
 if(prompt==='malformed') { console.log('{broken'); return; }
 writeFileSync('app.txt', 'changed\\n'); writeFileSync('new.txt','added\\n');
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.env.VISP_RUNNER_SECRET??'clean'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:50,output_tokens:10}}));
});
`;
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  spec = {
    schemaVersion: 1,
    id: "run-one",
    repository: repo,
    revision: git("rev-parse", "HEAD"),
    task: { feature: "001-feature-one", task: "T001" },
    prompt: "change the fixture",
    host: {
      kind: "codex",
      executable,
      executableSha256: sha256(script),
      version: "fake 1.0",
      model: "small",
    },
    permissions: { mode: "workspace-write", requireSandbox: false },
    budget: {
      maxDurationMs: 3000,
      maxEstimatedUsd: 1,
      studyMaxEstimatedUsd: 10,
      studyApprovalId: "fixture-approval",
      monetaryEnforcement: "estimated",
      prices: {
        source: "fixture",
        capturedAt: "2026-09-05T00:00:00Z",
        currency: "USD",
        model: "small",
        uncachedInputPerMillion: 1,
        cachedInputPerMillion: 0.1,
        cacheWriteInputPerMillion: 1,
        outputPerMillion: 2,
      },
    },
    harness: { mode: "disabled", files: [], requiredTools: [], requiredHooks: [] },
    assignment: {
      study: "pilot",
      scenario: "one",
      repositoryGroup: "repo-one",
      arm: "economical-baseline",
      split: "pilot",
      repetition: 0,
      order: 0,
    },
  };
});
afterEach(async () => {
  delete process.env.VISP_RUNNER_SECRET;
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("optional runner with real fixture processes", () => {
  it("isolates edits, strips ambient secrets, and verifies immutable receipts", async () => {
    process.env.VISP_RUNNER_SECRET = "do-not-inherit";
    const result = await runExperiment(spec, { outputRoot: join(root, "runs") });
    expect(result).toMatchObject({
      status: "completed",
      actualBilledUsd: null,
      provenance: "local-runner",
    });
    expect(result.estimatedUsd).toBeCloseTo(0.000075);
    expect(await readFile(join(repo, "app.txt"), "utf8")).toBe("original\n");
    const checked = await inspectRun(join(root, "runs", spec.id));
    expect(checked.result).toEqual(result);
    expect(checked.snapshot.files.map((file) => file.path)).toEqual(["app.txt", "new.txt"]);
    const event = await readFile(join(root, "runs", spec.id, "events", "00000002.json"), "utf8");
    expect(event).toContain("clean");
    expect(event).not.toContain("do-not-inherit");
    await expect(runExperiment(spec, { outputRoot: join(root, "runs") })).rejects.toThrow(/exist/i);
  });

  it("rejects version drift and unsupported promises before starting a paid host turn", async () => {
    await expect(
      runExperiment(
        { ...spec, host: { ...spec.host, version: "other" } },
        { outputRoot: join(root, "runs") },
      ),
    ).rejects.toThrow(/version/i);
    await expect(
      runExperiment(
        { ...spec, budget: { ...spec.budget, monetaryEnforcement: "strict" } },
        { outputRoot: join(root, "runs") },
      ),
    ).rejects.toThrow(/strict/i);
    await expect(
      runExperiment(
        { ...spec, permissions: { ...spec.permissions, requireSandbox: true } },
        { outputRoot: join(root, "runs") },
      ),
    ).rejects.toThrow(/sandbox/i);
  });

  it("records malformed streams and cancellation as unsuccessful attempts", async () => {
    const broken = await runExperiment(
      { ...spec, prompt: "malformed" },
      { outputRoot: join(root, "runs") },
    );
    expect(broken.status).toBe("failed");
    expect(broken.diagnostics.join(" ")).toMatch(/JSON/i);
    const controller = new AbortController();
    const pending = runExperiment(
      { ...spec, id: "cancelled", prompt: "hang" },
      { outputRoot: join(root, "runs"), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 250);
    expect((await pending).status).toBe("cancelled");
  });

  it("retains a cost-only host result without reporting complete attributable usage", async () => {
    const result = await runExperiment(
      { ...spec, host: { ...spec.host, kind: "claude" }, prompt: "cost-only" },
      { outputRoot: join(root, "runs") },
    );
    expect(result.status).toBe("failed");
    expect(result.estimatedUsd).toBe(0.01);
    expect(result.usage).toEqual([]);
    expect(result.diagnostics.join(" ")).toMatch(/attributable token usage/i);
  });

  it("rejects tampered evidence instead of trusting a previously green result", async () => {
    await runExperiment(spec, { outputRoot: join(root, "runs") });
    await writeFile(join(root, "runs", spec.id, "events", "00000001.json"), "{}\n");
    await expect(inspectRun(join(root, "runs", spec.id))).rejects.toThrow(/event|integrity/i);
  });

  it("records estimated budget overruns and read-only source changes as unsuccessful", async () => {
    expect(
      (
        await runExperiment(
          { ...spec, budget: { ...spec.budget, maxEstimatedUsd: 0.00001 } },
          { outputRoot: join(root, "runs") },
        )
      ).status,
    ).toBe("budget-exceeded");
    const changed = await runExperiment(
      { ...spec, id: "readonly", permissions: { mode: "read-only", requireSandbox: false } },
      { outputRoot: join(root, "runs") },
    );
    expect(changed.status).toBe("failed");
    expect(changed.diagnostics.join(" ")).toMatch(/read-only/);
  });

  it("retains failed-attempt allocation and refuses the next host launch at the study ceiling", async () => {
    const bounded = { ...spec, budget: { ...spec.budget, studyMaxEstimatedUsd: 1 } };
    const first = await runExperiment(
      { ...bounded, prompt: "malformed" },
      { outputRoot: join(root, "runs") },
    );
    expect(first.status).toBe("failed");
    expect(await readFile(join(root, "host-turns.log"), "utf8")).toBe("turn\n");
    await expect(
      runExperiment({ ...bounded, id: "unfunded-attempt" }, { outputRoot: join(root, "runs") }),
    ).rejects.toThrow(/study.*exhausted/i);
    expect(await readFile(join(root, "host-turns.log"), "utf8")).toBe("turn\n");
  });

  it("resumes only an explicit prior session with matching task, host, and source", async () => {
    const first = await runExperiment(spec, { outputRoot: join(root, "runs") });
    expect(first.sessionId).toBe("session-1");
    const resumed = await runExperiment(
      { ...spec, id: "run-two", prompt: "continue" },
      { outputRoot: join(root, "runs"), resumeFrom: join(root, "runs", spec.id) },
    );
    expect(resumed.status).toBe("completed");
    await expect(
      runExperiment(
        { ...spec, id: "wrong-task", task: { feature: "002-different", task: "T001" } },
        { outputRoot: join(root, "runs"), resumeFrom: join(root, "runs", spec.id) },
      ),
    ).rejects.toThrow(/resume/i);
  });

  it("binds a separate evaluator fixture to exact source and report receipts", async () => {
    await runExperiment(spec, { outputRoot: join(root, "runs") });
    const policyDirectory = join(root, "oracle");
    await mkdir(policyDirectory);
    await writeFile(join(policyDirectory, "run"), "pinned evaluator fixture");
    await chmod(join(policyDirectory, "run"), 0o700);
    const engine = join(root, "fake-engine");
    const engineCode = `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('engine fixture'); process.exit(0); }
if(process.argv.includes('inspect')) process.exit(1);
console.log(JSON.stringify({success:true,testResults:[{name:'accept.test.ts',assertionResults:[{fullName:'accepts patch',status:'passed'}]}]}));
`;
    await writeFile(engine, engineCode);
    await chmod(engine, 0o700);
    const runDirectory = join(root, "runs", spec.id);
    const receipt = await evaluateRun(runDirectory, {
      schemaVersion: 1,
      id: "independent",
      image: `example/evaluator@sha256:${"a".repeat(64)}`,
      engine: {
        executable: engine,
        executableSha256: sha256(engineCode),
        version: "engine fixture",
      },
      policyDirectory,
      policyHash: await hashEvaluatorPolicy(policyDirectory),
      command: ["/evaluator/run"],
      format: "vitest",
      reportFile: "report.json",
      requiredTests: ["accept.test.ts::accepts patch"],
      timeoutMs: 3000,
      uid: 1000,
      gid: 1000,
    });
    expect(receipt).toMatchObject({
      status: "accepted",
      authenticity: "requires-external-attestation",
    });
    expect(await inspectEvaluation(runDirectory, "independent")).toEqual(receipt);
    await writeFile(
      join(runDirectory, "evaluations", "independent", "results", "report.json"),
      "{}",
    );
    await expect(inspectEvaluation(runDirectory, "independent")).rejects.toThrow(
      /report.*integrity/i,
    );
    const slowEngineCode = `${engineCode}\nsetInterval(()=>{},1000);\n`;
    await writeFile(engine, slowEngineCode);
    const timedOut = await evaluateRun(runDirectory, {
      schemaVersion: 1,
      id: "timeout",
      image: `example/evaluator@sha256:${"a".repeat(64)}`,
      engine: {
        executable: engine,
        executableSha256: sha256(slowEngineCode),
        version: "engine fixture",
      },
      policyDirectory,
      policyHash: await hashEvaluatorPolicy(policyDirectory),
      command: ["/evaluator/run"],
      format: "vitest",
      reportFile: "report.json",
      requiredTests: ["accept.test.ts::accepts patch"],
      timeoutMs: 100,
      uid: 1000,
      gid: 1000,
    });
    expect(timedOut).toMatchObject({ status: "unchecked", execution: { reason: "timed-out" } });
  });
});
