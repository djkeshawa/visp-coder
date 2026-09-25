import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../../src/core/result.js";
import { runChecks } from "../../../src/doctor/checks.js";
import { preCommitHookPath } from "../../../src/harness/git-hook.js";
import { installHarness } from "../../../src/harness/install.js";
import { runInit } from "../../../src/workflow/stages/init.js";
import { loadWorkspace } from "../../../src/workflow/state.js";

let fixture = "";

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = "";
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function linkedRepository(): Promise<{ main: string; linked: string }> {
  fixture = await mkdtemp(join(tmpdir(), "visp-linked-worktree-"));
  const main = join(fixture, "main");
  const linked = join(fixture, "linked");
  await mkdir(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  await writeFile(join(main, "package.json"), '{"name":"fixture"}\n', "utf8");
  git(main, "add", "package.json");
  git(main, "commit", "-q", "-m", "initial");
  git(main, "worktree", "add", "-q", "-b", "linked", linked);
  const initialized = await runInit({ root: linked, harness: "codex" });
  if (!initialized.ok) throw new Error(initialized.error.message);
  return { main, linked };
}

describe("Git hooks in linked worktrees", () => {
  it("refuses the shared external hook path without changing it", async () => {
    const { main, linked } = await linkedRepository();
    const commonHook = join(main, ".git/hooks/pre-commit");
    await writeFile(commonHook, "#!/bin/sh\necho shared-sentinel\n", "utf8");
    const state = await loadWorkspace(linked);
    if (!state.ok) throw new Error(state.error.message);
    const configBefore = await readFile(state.value.paths.config, "utf8");

    const installed = await installHarness(
      state.value.paths,
      {
        harness: "codex",
        hooks: ["git"],
        mcp: false,
      },
      { guardHandshake: async () => ok(undefined) },
    );

    expect(installed.ok).toBe(false);
    if (installed.ok) return;
    expect(installed.error).toMatchObject({ code: "STAGE_BLOCKED" });
    expect(installed.error.recovery).toContain("extensions.worktreeConfig");
    expect(await readFile(commonHook, "utf8")).toContain("shared-sentinel");
    expect(await readFile(state.value.paths.config, "utf8")).toBe(configBefore);
    await expect(readFile(join(linked, "AGENTS.visp.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("installs a confined hook after explicit worktree-scoped activation", async () => {
    const { main, linked } = await linkedRepository();
    git(main, "config", "extensions.worktreeConfig", "true");
    git(linked, "config", "--worktree", "core.hooksPath", ".visp/hooks/git");
    const state = await loadWorkspace(linked);
    if (!state.ok) throw new Error(state.error.message);

    const installed = await installHarness(
      state.value.paths,
      {
        harness: "codex",
        hooks: ["git"],
        mcp: false,
      },
      { guardHandshake: async () => ok(undefined) },
    );
    expect(installed.ok).toBe(true);
    await expect(readFile(join(linked, ".visp/hooks/git/pre-commit"), "utf8")).resolves.toContain(
      "managed by visp",
    );

    const mainHook = await preCommitHookPath(main);
    expect(mainHook.ok && mainHook.value.absolute).toBe(join(main, ".git/hooks/pre-commit"));
    const refreshed = await loadWorkspace(linked);
    if (!refreshed.ok) throw new Error(refreshed.error.message);
    const report = await runChecks(refreshed.value, {
      guardHandshake: async () => ok(undefined),
    });
    const enforcement = report.checks.find((check) => check.name === "enforcement");
    expect(enforcement?.detail).toContain("pre-commit");
    expect(enforcement?.detail).not.toContain("not installed");
  });
});
