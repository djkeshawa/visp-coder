import { chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { inspectStateLock } from "../../../../src/core/state-lock.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { validateProductCheckCommand } from "../../../../src/workflow/product/check-command.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { executionSchema, productCheckSchema } from "../../../../src/workflow/product/model.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

const cliModule = new URL("../../../../src/cli/main.ts", import.meta.url).href;
const sourceDirectory = fileURLToPath(new URL("../../../../src/", import.meta.url));
const typescript = createRequire(import.meta.url).resolve("typescript");
// Load the real source in a separate process, without relying on a potentially stale dist build.
const childMutation = `
import {registerHooks} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from ${JSON.stringify(typescript)};
registerHooks({resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (fileURLToPath(candidate).startsWith(${JSON.stringify(sourceDirectory)}) && existsSync(candidate))
      return next(candidate.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.ts') && fileURLToPath(url).startsWith(${JSON.stringify(sourceDirectory)}))
    return {format:'module', shortCircuit:true, source:ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023},
    }).outputText};
  return next(url, context);
}});
const {main} = await import(${JSON.stringify(cliModule)});
process.exitCode = await main([process.execPath, "visp", "capture", "--from", "journey.json", "--json"]);
`;

describe("product command check execution boundary", () => {
  it("explains an unstartable check without treating manual prose as a product failure", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: brief.checks.map((check) => ({
            ...check,
            command: "visp-missing-executable open the page",
          })),
        },
        reason: "Exercise a missing executable through the real runner",
      }),
    ).toMatchObject({ ok: true });
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
    expect(await runProductVerify(await workspace.state())).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [
          {
            status: "environment-failed",
            output: expect.stringContaining("No product behavior was tested"),
          },
        ],
        next: { mayEdit: true, objective: expect.stringContaining("correcting its command") },
      },
    });
  });
  it.each([
    ["visp", "capture", "--from", "journey.json"],
    ["pnpm", "exec", "visp", "done"],
    ["npm", "exec", "--", "visp", "review", "--from", "review.json"],
    ["npx", "visp", "verify"],
    [
      "visp",
      "reproduce",
      "--finding",
      "FB-example",
      "--execution",
      "failed",
      "--reason",
      "reproduced",
    ],
  ])("rejects direct workflow recursion before spawning: %j", (...command) => {
    expect(
      validateProductCheckCommand(productCheckSchema.parse({ id: "C001", command })),
    ).toMatchObject({
      ok: false,
      error: {
        code: "ARTIFACT_INVALID",
        message: expect.stringContaining("browser-journey check"),
      },
    });
  });

  it("allows status reads and ordinary indirect test helpers", () => {
    for (const command of [
      ["visp", "status", "--feature", "work"],
      ["visp", "brief", "--template"],
      ["visp", "review", "--template"],
      ["visp", "install", "--dry-run"],
      ["node", "test/helper.mjs", "capture"],
      ["pnpm", "test", "--", "--grep", "visp capture"],
    ])
      expect(
        validateProductCheckCommand(productCheckSchema.parse({ id: "C001", command })),
      ).toEqual({ ok: true, value: undefined });
  });

  it("executes behavioral assertions through an ordinary imported helper and detects a real regression", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    await workspace.write(
      "test/behavior-helper.mjs",
      "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; export function checkValue() { assert.equal(value, 2); }\n",
    );
    await workspace.write(
      "test/forwarder.mjs",
      "import {checkValue} from './behavior-helper.mjs'; checkValue();\n",
    );
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: brief.checks.map((check) => ({
            ...check,
            command: [process.execPath, "test/forwarder.mjs"],
            files: ["test/*.mjs", "src/value.mjs"],
            verifierFiles: ["test/*.mjs"],
          })),
          slices: brief.slices.map((slice) => ({
            ...slice,
            scope: { ...slice.scope, allowed: [...slice.scope.allowed, "test/*.mjs"] },
          })),
        },
        reason: "Run real behavior assertions through an indirect test helper",
      }),
    ).toMatchObject({ ok: true });
    expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
    const initial = await runProductVerify(await workspace.state());
    expect(initial).toMatchObject({
      ok: true,
      value: {
        passed: true,
        executions: [
          {
            status: "passed",
            assertions: "agent-reported",
            verifierDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
    });
    await workspace.write("src/value.mjs", "export const value = 1;\n");
    const regressed = await runProductDone(await workspace.state());
    expect(regressed).toMatchObject({
      ok: true,
      value: {
        closed: false,
        executions: [{ status: "failed", output: expect.stringContaining("AssertionError") }],
      },
    });
    if (!initial.ok || !regressed.ok) throw new Error("Expected execution receipts");
    expect(regressed.value.executions[0]?.verifierDigest).toBe(
      initial.value.executions[0]?.verifierDigest,
    );
    await workspace.write("test/behavior-helper.mjs", "export function checkValue() {}\n");
    const weakened = await runProductVerify(await workspace.state());
    expect(weakened).toMatchObject({ ok: true, value: { executions: [{ status: "passed" }] } });
    if (!weakened.ok) throw new Error("Expected weakened verifier receipt");
    expect(weakened.value.executions[0]?.verifierDigest).not.toBe(
      initial.value.executions[0]?.verifierDigest,
    );
    expect(weakened.value.executions[0]?.commandVerifier?.verifier).not.toBe(
      initial.value.executions[0]?.commandVerifier?.verifier,
    );
    expect(weakened.value.executions[0]?.commandVerifier?.executable).toBe(
      initial.value.executions[0]?.commandVerifier?.executable,
    );
  });

  it("refuses to execute an explicit Node assertion omitted from verifierFiles", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const omitted = await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        checks: brief.checks.map((check) => ({
          ...check,
          verifierFiles: ["src/value.mjs"],
        })),
      },
      reason: "Exercise a missing assertion declaration",
    });
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) throw new Error(omitted.error.message);
    const refused = await runProductVerify(await workspace.state());
    expect(refused).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [{ status: "environment-failed", exitCode: -1, durationMs: 0 }],
      },
    });
    if (!refused.ok) throw new Error(refused.error.message);
    expect(refused.value.executions[0]?.output).not.toContain("AssertionError");
    expect(refused.value.executions[0]?.output).toContain("assertion entry");
    expect(refused.value.executions[0]?.verifierDigest).toBeUndefined();

    const corrected = await updateProductBrief(await workspace.state(), {
      brief: {
        ...omitted.value,
        checks: omitted.value.checks.map((check) => ({
          ...check,
          verifierFiles: ["test/value.test.mjs"],
        })),
      },
      reason: "Declare the assertion entry before verification",
    });
    expect(corrected.ok).toBe(true);
    expect(await runProductVerify(await workspace.state())).toMatchObject({
      ok: true,
      value: {
        executions: [
          {
            status: "failed",
            output: expect.stringContaining("AssertionError"),
            verifierDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
    });
  });

  it.each([
    { declaration: "test/missing-helper.mjs", restored: "test/missing-helper.mjs" },
    { declaration: "missing-verifiers/*.mjs", restored: "missing-verifiers/check.mjs" },
  ])(
    "refuses missing verifier dependencies and resumes after restoration ($declaration)",
    async ({ declaration, restored }) => {
      const { workspace, brief } = await productWorkspace();
      workspaces.push(workspace);
      expect(
        (
          await updateProductBrief(await workspace.state(), {
            brief: {
              ...brief,
              checks: brief.checks.map((check) => ({
                ...check,
                command: [process.execPath, "-e", "console.log('VERIFIER_RAN')"],
                verifierFiles: ["test/value.test.mjs", declaration],
              })),
            },
            reason: "Declare all assertion inputs before executing verification",
          })
        ).ok,
      ).toBe(true);
      const result = await runProductVerify(await workspace.state());
      expect(result).toMatchObject({
        ok: true,
        value: {
          passed: false,
          executions: [
            {
              status: "environment-failed",
              exitCode: -1,
              output: expect.stringContaining("verifier"),
            },
          ],
        },
      });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.executions[0]?.output).not.toContain("VERIFIER_RAN");
      expect(result.value.executions[0]?.verifierDigest).toBeUndefined();
      await workspace.write(restored, "export const expected = 2;\n");
      expect(await runProductVerify(await workspace.state())).toMatchObject({
        ok: true,
        value: {
          passed: true,
          executions: [
            {
              status: "passed",
              output: "VERIFIER_RAN",
              verifierDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
        },
      });
    },
  );

  it("changes verifier identity when the command executable is replaced", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const tool = ".visp/tools/verify";
    await workspace.write(tool, "#!/bin/sh\nexit 1\n");
    await chmod(join(workspace.root, tool), 0o755);
    expect(
      (
        await updateProductBrief(await workspace.state(), {
          brief: {
            ...brief,
            checks: brief.checks.map((check) => ({
              ...check,
              command: [join(workspace.root, tool)],
              verifierFiles: ["test/value.test.mjs"],
            })),
          },
          reason: "Pin assertion inputs for an executable verifier",
        })
      ).ok,
    ).toBe(true);
    const before = await runProductVerify(await workspace.state());
    expect(before).toMatchObject({
      ok: true,
      value: { executions: [{ status: "failed", verifierDigest: expect.any(String) }] },
    });
    await workspace.write(tool, "#!/bin/sh\nexit 0\n");
    await chmod(join(workspace.root, tool), 0o755);
    const after = await runProductVerify(await workspace.state());
    expect(after).toMatchObject({
      ok: true,
      value: { executions: [{ status: "passed", verifierDigest: expect.any(String) }] },
    });
    if (!before.ok || !after.ok) throw new Error("missing executions");
    expect(after.value.executions[0]?.verifierDigest).not.toBe(
      before.value.executions[0]?.verifierDigest,
    );
    const first = before.value.executions[0];
    const last = after.value.executions[0];
    expect(first?.commandVerifier).toMatchObject({
      version: 2,
      verifier: expect.any(String),
      executable: expect.any(String),
    });
    expect(last?.commandVerifier?.verifier).toBe(first?.commandVerifier?.verifier);
    expect(last?.commandVerifier?.executable).not.toBe(first?.commandVerifier?.executable);
    expect(last?.verifierDigest).toBe(hashValue(last?.commandVerifier));
    if (!last) throw new Error("Missing current execution");
    const { commandVerifier: _components, ...legacy } = last;
    expect(executionSchema.parse(legacy)).not.toHaveProperty("commandVerifier");
    expect(
      executionSchema.safeParse({
        ...last,
        commandVerifier: { ...last?.commandVerifier, verifier: "0".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("withholds verifier identity when the executable changes during its run", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const tool = ".visp/tools/self-changing";
    await workspace.write(tool, "#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n' > \"$0\"\nexit 0\n");
    await chmod(join(workspace.root, tool), 0o755);
    expect(
      (
        await updateProductBrief(await workspace.state(), {
          brief: {
            ...brief,
            checks: brief.checks.map((check) => ({
              ...check,
              command: [join(workspace.root, tool)],
              verifierFiles: ["test/value.test.mjs"],
            })),
          },
          reason: "Exercise an unstable verification tool",
        })
      ).ok,
    ).toBe(true);
    const result = await runProductVerify(await workspace.state());
    expect(result).toMatchObject({ ok: true, value: { executions: [{ status: "passed" }] } });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.executions[0]?.verifierDigest).toBeUndefined();
    expect(result.value.executions[0]?.commandVerifier).toBeUndefined();
    expect(result.value.executions[0]?.output).toContain("cannot support a witnessed repair");
    expect(result.value.executions[0]?.output).toContain("rerun");
  });

  it("records an actionable direct command failure without requiring the executable to exist", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    expect(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: brief.checks.map((check) => ({
            ...check,
            command: ["visp", "capture", "--from", "journey.json"],
          })),
        },
        reason: "Reproduce an accidental recursive browser check",
      }),
    ).toMatchObject({ ok: true });
    const result = await runProductVerify(await workspace.state());
    expect(result).toMatchObject({
      ok: true,
      value: {
        passed: false,
        executions: [
          {
            status: "environment-failed",
            output: expect.stringContaining("recursively mutate"),
            durationMs: expect.any(Number),
          },
        ],
      },
    });
    expect(await inspectStateLock(workspace.root)).toMatchObject({
      ok: true,
      value: { state: "unlocked" },
    });
  });

  it.each([false, true])(
    "done rejects a real grandchild CLI capture even when its wrapper masks failure=%s",
    async (masked) => {
      const { workspace, brief } = await productWorkspace();
      workspaces.push(workspace);
      await workspace.write(
        "test/nested.mjs",
        `
import {spawnSync} from 'node:child_process';
const child = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childMutation)}], {encoding:'utf8'});
${masked ? "process.exitCode = 0;" : "process.stdout.write(child.stdout); process.stderr.write(child.stderr); process.exitCode = child.status ?? 1;"}
`,
      );
      expect(
        await updateProductBrief(await workspace.state(), {
          brief: {
            ...brief,
            checks: brief.checks.map((check) => ({
              ...check,
              command: [process.execPath, "test/nested.mjs"],
              files: ["test/nested.mjs"],
            })),
          },
          reason: "Exercise a legitimate helper that accidentally invokes a workflow writer",
        }),
      ).toMatchObject({ ok: true });
      expect(await runProductWork(await workspace.state())).toMatchObject({ ok: true });
      const result = await runProductDone(await workspace.state());
      expect(result).toMatchObject({
        ok: true,
        value: {
          closed: false,
          executions: [
            {
              status: "environment-failed",
              output: expect.stringContaining("recursively mutate"),
            },
          ],
        },
      });
      // CLI startup and source compilation vary with host load; the guard's diagnostic,
      // receipt and acquisition-boundary tests establish refusal before waiting on the lock.
      expect(await inspectStateLock(workspace.root)).toMatchObject({
        ok: true,
        value: { state: "unlocked" },
      });
    },
  );
});
