import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overrideCommand } from "../../../src/cli/commands/override.js";
import { policyCommand } from "../../../src/cli/commands/policy.js";
import * as context from "../../../src/cli/context.js";
import { ok } from "../../../src/core/result.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
let exitCode: typeof process.exitCode;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
  exitCode = process.exitCode;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
  await workspace.destroy();
});

async function run(...args: string[]): Promise<void> {
  const command = new Command()
    .option("--project <path>")
    .option("--json")
    .addCommand(policyCommand())
    .addCommand(overrideCommand());
  await command.parseAsync(["node", "visp", "--project", workspace.root, "--json", ...args]);
}

describe("concurrent policy mutations", () => {
  it("retains every accepted rule decision and strictness update", async () => {
    // All handlers may load the same revision before any one of them writes.
    vi.spyOn(context, "mutatingWorkspace").mockResolvedValue(ok(await workspace.state()));
    const rules = ["evidence.test-signal", "scope.max-changed-files", "scope.allowed-files"];
    await Promise.all([
      ...rules.map((rule) => run("policy", "set", rule, "on")),
      run("policy", "set-strictness", "strict"),
    ]);

    const { policy } = await workspace.state();
    expect(policy.strictness).toBe("strict");
    expect(policy.rules).toEqual(Object.fromEntries(rules.map((rule) => [rule, true])));
  });

  it("allocates distinct override ids and retains a concurrent revocation", async () => {
    await run("override", "create", "evidence.test-signal", "--reason", "First bounded exception");
    vi.spyOn(context, "mutatingWorkspace").mockResolvedValue(ok(await workspace.state()));
    await Promise.all([
      ...Array.from({ length: 6 }, (_, index) =>
        run(
          "override",
          "create",
          "evidence.test-signal",
          "--reason",
          `Exception for task ${index}`,
        ),
      ),
      run("override", "revoke", "OV001"),
    ]);

    const { overrides } = await workspace.state();
    expect(overrides).toHaveLength(7);
    expect(new Set(overrides.map((entry) => entry.id)).size).toBe(7);
    expect(overrides.find((entry) => entry.id === "OV001")?.revokedAt).toBeDefined();
  });

  it("rejects an unknown on/off value without recording an unintended decision", async () => {
    await run("policy", "set", "scope.forbidden-paths", "false");
    expect(process.exitCode).not.toBe(0);
    expect((await workspace.state()).policy.rules).toEqual({});
  });
});
