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
async function execute(message: string, timeoutMs?: number) {
  ({ workspace } = await productWorkspace());
  const state = await workspace.state();
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const check = productCheckSchema.parse({
    id: "C001",
    command: [
      process.execPath,
      "-e",
      timeoutMs
        ? "setInterval(() => {}, 1000)"
        : `console.error(${JSON.stringify(message)});process.exit(1)`,
    ],
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return executeProductCheck(state, record.value, undefined, check, "subject");
}

it("records a per-check timeout separately from a product assertion failure", async () => {
  const result = await execute("", 100);
  expect(result.execution).toMatchObject({
    status: "timed-out",
    output: expect.stringContaining("timed out"),
  });
});

it.each(["Error: spawnSync /usr/bin/node EPERM", "Error: spawn /usr/bin/node EACCES"])(
  "recognizes the real spawn denial: %s",
  async (message) => {
    const result = await execute(message);
    expect(result.execution).toMatchObject({
      status: "environment-failed",
      output: expect.stringContaining("sandbox"),
    });
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
