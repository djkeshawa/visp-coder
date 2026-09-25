import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preCommitHookPath } from "../../../src/harness/git-hook.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("preCommitHookPath", () => {
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
