import { afterEach, expect, it, vi } from "vitest";
import { executeProductCheck } from "../../../../src/workflow/product/check-execution.js";
import { productCheckSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => {
  vi.unstubAllEnvs();
  await workspace?.destroy();
});
async function execute(message: string, timeoutMs?: number, configured = false, exitCode = 1) {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const check = productCheckSchema.parse({
    id: configured ? "CONFIG_1" : "C001",
    command: [
      process.execPath,
      "-e",
      timeoutMs
        ? "setInterval(() => {}, 1000)"
        : `console.error(${JSON.stringify(message)});process.exit(${exitCode})`,
    ],
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return executeProductCheck(
    configured
      ? {
          ...state,
          config: {
            ...state.config,
            workflow: {
              ...state.config.workflow,
              validationCommands: [check.command as [string, ...string[]]],
            },
          },
        }
      : state,
    record.value,
    undefined,
    check,
    "subject",
  );
}

it.each([
  ["sh: 1: eslint: not found", "eslint", 127],
  ["sh: 1: ./node_modules/.bin/karma: not found", "./node_modules/.bin/karma", 1],
  ["bash: ruff: command not found", "ruff", 1],
  ['npm error Missing script: "test"', "test", 1],
  ["", process.execPath, 127],
])("classifies a configured missing tool: %s", async (message, tool, exitCode) => {
  const result = await execute(message as string, undefined, true, exitCode as number);
  expect(result.execution.status).toBe("environment-failed");
  expect(result.execution.output).toContain(tool);
  expect(result.execution.output).toContain("workflow.validationCommands");
  expect(result.execution.output).toContain("missing-command:");
});

it("keeps worker-declared missing-tool output a product failure", async () => {
  const result = await execute("sh: 1: eslint: not found", undefined, false, 127);
  expect(result.execution.status).toBe("failed");
});

it("records a per-check timeout separately from a product assertion failure", async () => {
  const result = await execute("", 100);
  expect(result.execution).toMatchObject({
    status: "timed-out",
    output: expect.stringContaining("timed out"),
  });
});

it.each([
  "Error: spawnSync /usr/bin/node EPERM",
  "Error: spawn EPERM",
  "Error: spawnSync /Users/Jane Doe/bin/node EPERM",
  "Error: execSync /usr/bin/node EPERM",
  "Error: fork /usr/bin/node EPERM",
])("recognizes the real spawn denial: %s", async (message) => {
  const result = await execute(message);
  expect(result.execution).toMatchObject({
    status: "environment-failed",
    output: expect.stringContaining("sandbox"),
  });
});

it("keeps a non-executable product script a product failure outside a sandbox", async () => {
  for (const name of [
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_PERMISSION_PROFILE",
  ])
    vi.stubEnv(name, "");
  const result = await execute("Error: spawn ./run.sh EACCES");
  expect(result.execution).toMatchObject({ status: "failed" });
  expect(result.execution.output).not.toContain("sandbox");
});

it.each(["Error: spawn /usr/bin/node EACCES", "Error: spawn /opt/Some Tool/bin/node EACCES"])(
  "recognizes a denied spawn of an outside-root executable inside a sandbox: %s",
  async (message) => {
    vi.stubEnv("CODEX_SANDBOX", "workspace-write");
    const result = await execute(message);
    expect(result.execution).toMatchObject({ status: "environment-failed" });
  },
);

it("recognizes an outside-root filesystem denial in a sandbox", async () => {
  vi.stubEnv("CODEX_SANDBOX", "workspace-write");
  const result = await execute("Error: EACCES: permission denied, open '/outside/workspace/cache'");
  expect(result.execution).toMatchObject({
    status: "environment-failed",
    output: expect.stringContaining("sandbox"),
  });
});

it("keeps an uncertain permission error failed but adds context", async () => {
  vi.stubEnv("CODEX_SANDBOX", "workspace-write");
  const result = await execute("Chrome: Operation not permitted");
  expect(result.execution).toMatchObject({
    status: "failed",
    output: expect.stringContaining("sandbox"),
  });
});
