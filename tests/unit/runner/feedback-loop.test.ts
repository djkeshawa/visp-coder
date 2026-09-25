import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../../src/core/hash.js";
import type { RunnerSpec } from "../../../src/runner/contracts.js";
import { buildRunnerProgram } from "../../../src/runner/main.js";
import { inspectRun, runExperiment } from "../../../src/runner/run.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(mode = "repair", kind: RunnerSpec["host"]["kind"] = "codex") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "visp-loop-test-")));
  roots.push(root);
  const repo = join(root, "repo");
  execFileSync("git", ["init", "--quiet", repo]);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("config", "user.email", "loop@example.invalid");
  git("config", "user.name", "Loop fixture");
  await writeFile(join(repo, "entrypoint.mjs"), "console.log(0);\n");
  await writeFile(join(repo, "guide.md"), "Fixture harness\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const log = join(root, "phases.log");
  const executable = join(root, "host.mjs");
  const script = `#!${process.execPath}
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')) { console.log('fixture 1'); process.exit(0); }
let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',v=>text+=v);
process.stdin.on('end',async()=>{
 const review=text.startsWith('VISP_REVIEW_REQUEST\\n');
 const request=review?JSON.parse(text.slice('VISP_REVIEW_REQUEST\\n'.length)):null;
 const phase=review?'review':'actor';
 appendFileSync(${JSON.stringify(log)},phase+'-start\\n');
 const session=review?'review-session':'actor-session';
 console.log(JSON.stringify(${JSON.stringify(kind)}==='claude'?{type:'system',subtype:'init',session_id:session,model:'fixture'}:{type:'thread.started',thread_id:session}));
 let output='Runnable slice ready for independent review';
 if(review) {
   if(${JSON.stringify(mode)}==='hang') {setInterval(()=>{},1000);return;}
   if(${JSON.stringify(mode)}==='mutate') writeFileSync('entrypoint.mjs','console.log(999);\\n');
   const actual=execFileSync(process.execPath,['entrypoint.mjs'],{encoding:'utf8'}).trim();
   const unavailable=${JSON.stringify(mode)}==='unavailable';
   const needsEvidence=${JSON.stringify(mode)}.startsWith('evidence') && !request.previous;
   output=JSON.stringify({subjectDigest:request.subjectDigest,decision:unavailable?'unavailable':needsEvidence?'evidence':actual==='2'?'pass':'repair',
     checks:[{id:'entrypoint',status:unavailable||needsEvidence?'unverified':actual==='2'?'passed':'failed',exercise:'node entrypoint.mjs',observed:actual,evidence:unavailable||needsEvidence?[]:['stdout='+actual]}],
     findings:unavailable||needsEvidence?[]:actual==='2'?[]:[{criterion:'entrypoint',problem:'Public entry point returns '+actual+' instead of 2',nextCheck:'Run node entrypoint.mjs and expect 2'}]});
 } else {
   const repaired=text.includes('Public entry point returns');
   writeFileSync('entrypoint.mjs',repaired||${JSON.stringify(mode)}.startsWith('evidence')?'console.log(2);\\n':'console.log(1);\\n');
   if(${JSON.stringify(mode)}==='evidence-mutate' && text.includes('Address this review')) writeFileSync('entrypoint.mjs','console.log(3);\\n');
   if(${JSON.stringify(mode)}==='actor-checkpoint' && !repaired) {setInterval(()=>{},1000);return;}
 }
 if(${JSON.stringify(mode)}==='requirements' || ${JSON.stringify(mode)}==='review-only-tool') {
   const tool=review?'critic':text.includes('Public entry point returns')?'done':'work';
   console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',id:'tool-1',server:'visp',tool,status:'completed'}}));
   if(tool==='done') {
     const item={type:'command_execution',id:'command-1',command:JSON.stringify(process.execPath)+' entrypoint.mjs'};
     console.log(JSON.stringify({type:'item.started',item:{...item,status:'in_progress'}}));
     execFileSync(process.execPath,['entrypoint.mjs']);
     console.log(JSON.stringify({type:'item.completed',item:{...item,status:'completed',exit_code:0}}));
   }
 }
 await new Promise(resolve=>setTimeout(resolve,20));
 appendFileSync(${JSON.stringify(log)},phase+'-exit\\n');
 const usage={input_tokens:100,output_tokens:10};
 if(${JSON.stringify(kind)}==='claude') console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:session,result:output,usage}));
 else {
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:output}}));
  console.log(JSON.stringify({type:'turn.completed',usage}));
 }
});
`;
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  const spec: RunnerSpec = {
    schemaVersion: 1,
    id: "loop",
    repository: repo,
    revision: git("rev-parse", "HEAD"),
    task: { feature: "001-loop", task: "T001" },
    prompt: "Make the public entry point return 2",
    host: {
      kind,
      executable,
      executableSha256: sha256(script),
      version: "fixture 1",
      model: "fixture",
    },
    permissions: { mode: "workspace-write", requireSandbox: false },
    budget: {
      maxDurationMs: 6000,
      maxEstimatedUsd: 1,
      studyMaxEstimatedUsd: 1,
      studyApprovalId: "local-fixture",
      monetaryEnforcement: "estimated",
      prices: {
        source: "fixture",
        capturedAt: "2026-09-20T00:00:00Z",
        currency: "USD",
        model: "fixture",
        uncachedInputPerMillion: 1,
        cachedInputPerMillion: 1,
        cacheWriteInputPerMillion: 1,
        outputPerMillion: 1,
      },
    },
    harness: ["requirements", "review-only-tool"].includes(mode)
      ? {
          mode: "visp",
          files: [{ path: "guide.md", sha256: sha256("Fixture harness\n") }],
          requiredTools: ["visp.work"],
          requiredHooks: [],
        }
      : { mode: "disabled", files: [], requiredTools: [], requiredHooks: [] },
    assignment: {
      study: "loop-fixture",
      scenario: "entrypoint",
      repositoryGroup: "fixture",
      arm: "economical-baseline",
      split: "learning",
      repetition: 0,
      order: 0,
    },
    feedbackLoop: {
      maxRounds: 2,
      actorMaxDurationMs: 1000,
      reviewMaxDurationMs: 1000,
      criteria: [{ id: "entrypoint", expectation: "node entrypoint.mjs prints 2" }],
    },
  };
  return { root, spec, log, outputRoot: join(root, "runs") };
}

describe.skipIf(process.platform === "win32")(
  "scheduled turns with POSIX fixture executables",
  () => {
    it("checks harness requirements across actor turns without demanding final checks at the first handoff", async () => {
      const { spec, outputRoot } = await fixture("requirements");
      const result = await runExperiment(
        {
          ...spec,
          harness: {
            ...spec.harness,
            requiredTools: ["visp.work", "visp.done"],
            requiredCommands: [[process.execPath, "entrypoint.mjs"]],
          },
        },
        { outputRoot },
      );
      expect(result.status, result.diagnostics.join(" ")).toBe("completed");
      expect(result.feedbackLoop?.rounds).toBe(2);
    });

    it("does not use a reviewer's tools to satisfy missing actor requirements", async () => {
      const { spec, outputRoot } = await fixture("review-only-tool");
      const result = await runExperiment(
        { ...spec, harness: { ...spec.harness, requiredTools: ["visp.critic"] } },
        { outputRoot },
      );
      expect(result.status).toBe("failed");
      expect(result.feedbackLoop?.review?.decision).toBe("pass");
      expect(result.diagnostics.join(" ")).toContain("Required tool was not observed: visp.critic");
    });

    it("executes the configured loop through the public runner command", async () => {
      const { root, spec, outputRoot } = await fixture();
      const input = join(root, "run.json");
      await writeFile(input, JSON.stringify(spec));
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      await buildRunnerProgram().parseAsync([
        "node",
        "visp-runner",
        "run",
        "--spec",
        input,
        "--output",
        outputRoot,
      ]);
      const printed = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(printed.status).toBe("completed");
      expect(printed.feedbackLoop).toMatchObject({
        decision: "pass",
        rounds: 2,
        repairAttempts: 1,
      });
      expect((await inspectRun(join(outputRoot, spec.id))).result).toEqual(printed);
    });
    it.each(["codex", "claude"] as const)(
      "pauses the %s actor, consumes a concrete failure and rechecks the real entry point within one allowance",
      async (kind) => {
        const { root, spec, log, outputRoot } = await fixture("repair", kind);
        const result = await runExperiment(spec, { outputRoot });
        expect(result.status, result.diagnostics.join("\n")).toBe("completed");
        expect(await readFile(log, "utf8")).toBe(
          "actor-start\nactor-exit\nreview-start\nreview-exit\nactor-start\nactor-exit\nreview-start\nreview-exit\n",
        );
        expect(result.feedbackLoop).toMatchObject({
          decision: "pass",
          rounds: 2,
          repairAttempts: 1,
        });
        expect(result.usage).toHaveLength(4);
        expect(result.estimatedUsd).toBeCloseTo(0.00044);
        expect((await inspectRun(join(outputRoot, spec.id))).result).toEqual(result);
        expect(await readFile(join(root, "repo", "entrypoint.mjs"), "utf8")).toBe(
          "console.log(0);\n",
        );
      },
    );

    it.each(["unavailable", "mutate", "hang"])(
      "does not restart the actor or claim success after review %s",
      async (mode) => {
        const { spec, log, outputRoot } = await fixture(mode);
        const result = await runExperiment(spec, { outputRoot });
        expect(result.status).not.toBe("completed");
        expect((await readFile(log, "utf8")).match(/actor-start/g)).toHaveLength(1);
        expect(result.feedbackLoop?.decision).not.toBe("pass");
      },
    );

    it("hands off an interrupted actor at its checkpoint and preserves missing cost as unknown", async () => {
      const { spec, log, outputRoot } = await fixture("actor-checkpoint");
      const result = await runExperiment(spec, { outputRoot });
      expect(await readFile(log, "utf8")).toContain("actor-start\nreview-start\n");
      expect(result.feedbackLoop?.review?.decision).toBe("pass");
      expect(result.estimatedUsd).toBeNull();
      expect(result.status).toBe("failed");
      expect(result.diagnostics.join(" ")).toContain("usage");
    });

    it("resumes only evidence collection when the reviewer needs observations", async () => {
      const { spec, outputRoot } = await fixture("evidence");
      const result = await runExperiment(spec, { outputRoot });
      expect(result.status, result.diagnostics.join(" ")).toBe("completed");
      expect(result.feedbackLoop).toMatchObject({ evidenceRequests: 1, repairAttempts: 0 });
    });

    it("rejects an implementation change during an evidence-only turn", async () => {
      const { spec, log, outputRoot } = await fixture("evidence-mutate");
      const result = await runExperiment(spec, { outputRoot });
      expect(result.status).toBe("failed");
      expect(result.diagnostics.join(" ")).toContain("evidence-only");
      expect((await readFile(log, "utf8")).match(/review-start/g)).toHaveLength(1);
    });

    it("charges actor and reviewer against one budget and stops before another unfunded phase", async () => {
      const { spec, log, outputRoot } = await fixture();
      const result = await runExperiment(
        { ...spec, budget: { ...spec.budget, maxEstimatedUsd: 0.0003 } },
        { outputRoot },
      );
      expect(result.status).toBe("budget-exceeded");
      expect((await readFile(log, "utf8")).match(/actor-start/g)).toHaveLength(1);
      expect(result.usage).toHaveLength(2);
    });
  },
);
