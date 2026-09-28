import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preCommitHookPath } from "../../../src/harness/git-hook.js";
import { installHarness } from "../../../src/harness/install.js";
import { TestWorkspace } from "../support/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("preCommitHookPath", () => {
  it("chains an untracked foreign hook and refuses to replace a tracked one", async () => {
    const workspace = await TestWorkspace.create();
    try {
      const hook = join(workspace.root, ".husky/pre-commit");
      await mkdir(join(workspace.root, ".husky"), { recursive: true });
      await writeFile(hook, "#!/bin/sh\necho lint-staged\n");
      await chmod(hook, 0o755);
      execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: workspace.root });
      const state = await workspace.state();
      const chained = await installHarness(
        state.paths,
        { harness: "generic", hooks: ["git"], force: true },
        { guardHandshake: async () => ({ ok: true, value: undefined }) },
      );
      expect(chained.ok).toBe(true);
      expect(await readFile(`${hook}.local`, "utf8")).toContain("lint-staged");
      expect(await readFile(hook, "utf8")).toContain('"$0.local"');
      await writeFile(hook, "#!/bin/sh\necho tracked\n");
      execFileSync("git", ["add", ".husky/pre-commit"], { cwd: workspace.root });
      const refused = await installHarness(
        state.paths,
        { harness: "generic", hooks: ["git"], force: true },
        { guardHandshake: async () => ({ ok: true, value: undefined }) },
      );
      expect(refused.ok).toBe(false);
      expect(await readFile(hook, "utf8")).toContain("tracked");
    } finally {
      await workspace.destroy();
    }
  });
  it("returns a structured failure outside a Git repository", async () => {
    const root = await temporaryRoot();

    const result = await preCommitHookPath(root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("COMMAND_FAILED");
  });

  it("keeps an absolute configured hooks path visible as absolute", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "core.hooksPath", outside], { cwd: root });

    const result = await preCommitHookPath(root);

    expect(result.ok && result.value.absolute).toBe(join(outside, "pre-commit"));
    expect(result.ok && result.value.display).toBe(join(outside, "pre-commit"));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-git-hook-"));
  roots.push(root);
  return root;
}
