import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { usageCommand } from "../../../src/cli/commands/usage.js";
import { TestWorkspace } from "../support/workspace.js";

describe("usageCommand", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  it("exports an unregistered command group with an explicit import command", async () => {
    workspace = await TestWorkspace.create();
    const command = usageCommand();

    expect(command.name()).toBe("usage");
    expect(command.commands.map((child) => child.name())).toEqual(["rebuild", "import"]);

    const program = new Command("visp").option("--project <path>").option("--json");
    program.addCommand(command);
    program.exitOverride();
    for (const child of command.commands) child.exitOverride();

    const outer = process.exitCode;
    const originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.exitCode = undefined;
    try {
      await program.parseAsync([
        "node",
        "visp",
        "--project",
        workspace.root,
        "usage",
        "import",
        "--source",
        "unknown-host",
        "--file",
        "unused.jsonl",
        "--json",
      ]);
      expect(process.exitCode).not.toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = outer;
    }
  });
});
