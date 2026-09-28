import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { run } from "../../src/core/exec.js";
import { TestWorkspace } from "../unit/support/workspace.js";

it.skipIf(process.platform !== "win32")(
  "installs, runs its Git hook, and starts an npm check on native Windows",
  async () => {
    const workspace = await TestWorkspace.create();
    try {
      const cli = resolve("dist/cli.js");
      const installed = execFileSync(
        process.execPath,
        [cli, "--project", workspace.root, "install", "--harness", "generic", "--json"],
        {
          cwd: workspace.root,
          encoding: "utf8",
        },
      );
      expect(JSON.parse(installed).ok).toBe(true);
      workspace.git("commit", "--allow-empty", "-m", "exercise installed pre-commit");
      const npm = await run("npm", ["--version"], { cwd: workspace.root });
      expect(npm.ok && npm.value.exitCode).toBe(0);
      const npmShim = await run("npm.cmd", ["--version"], { cwd: workspace.root });
      expect(npmShim.ok && npmShim.value.exitCode).toBe(0);
    } finally {
      await workspace.destroy();
    }
  },
);
