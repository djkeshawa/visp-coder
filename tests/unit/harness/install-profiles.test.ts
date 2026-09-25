import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exists } from "../../../src/core/fs.js";
import { installHarness } from "../../../src/harness/install.js";
import { TestWorkspace } from "../support/workspace.js";

/**
 * Switching profiles must be a rewrite of visp's own files, never of the
 * user's: assets the new profile does not install are pruned only when their
 * content is provably what visp wrote.
 */

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  await workspace.destroy();
});

async function install(profile: "standard" | "minimal") {
  const state = await workspace.state();
  const result = await installHarness(state.paths, { harness: "claude-code", profile });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function file(path: string): string {
  return join(workspace.root, path);
}

describe("profile switching", () => {
  it("prunes the standard-only assets on the way down to minimal", async () => {
    await install("standard");
    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(true);

    const outcome = await install("minimal");

    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(false);
    expect(await exists(file(".claude/agents/visp-scout.md"))).toBe(false);
    expect(await exists(file(".claude/commands/visp-pr.md"))).toBe(false);
    expect(await exists(file(".claude/commands/visp-next.md"))).toBe(true);
    expect(outcome.assets.some((asset) => asset.status === "removed")).toBe(true);
  });

  it("rewrites the guide in place across a switch, without --force", async () => {
    await install("standard");
    await install("minimal");

    const guide = await readFile(file("AGENTS.visp.md"), "utf8");
    expect(guide).toContain("Before the final answer, run `visp next`");
    expect(guide).toContain("visp work");
  });

  it("restores the full surface on the way back up", async () => {
    await install("standard");
    await install("minimal");
    await install("standard");

    expect(await exists(file(".claude/skills/visp/SKILL.md"))).toBe(true);
    expect(await exists(file(".claude/agents/visp-scout.md"))).toBe(true);
  });

  it("keeps a user-edited file and says so instead of deleting it", async () => {
    await install("standard");
    await writeFile(file(".claude/skills/visp/SKILL.md"), "my own notes\n", "utf8");

    const outcome = await install("minimal");

    expect(await readFile(file(".claude/skills/visp/SKILL.md"), "utf8")).toBe("my own notes\n");
    expect(outcome.manualSteps.join(" ")).toContain(".claude/skills/visp/SKILL.md");
  });

  it("is idempotent: a repeated install changes nothing", async () => {
    await install("minimal");
    const outcome = await install("minimal");

    expect(outcome.assets.every((asset) => asset.status === "unchanged")).toBe(true);
  });
});
