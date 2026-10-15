import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { runtimeIdentity } from "../../../src/core/version.js";
import {
  isCurrentGeneratedHook,
  renderCiWorkflow,
  renderClaudeSettingsSnippet,
  renderCodexHooks,
  renderPreCommitHook,
  renderPreToolUseHook,
} from "../../../src/harness/hooks.js";

describe("generated configuration files parse", () => {
  it("renders a CI workflow that is valid YAML", () => {
    const workflow = renderCiWorkflow("1.2");
    const document = parseDocument(workflow);
    expect(document.errors).toEqual([]);
    expect(document.warnings).toEqual([]);

    const parsed = parse(workflow);
    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.on).toEqual({ pull_request: null });
    const steps = parsed.jobs["scope-and-evidence"].steps;
    expect(steps).toHaveLength(4);
    expect(steps[1].with["node-version"]).toBe(22);
    expect(steps[2].run).toContain("@1.2");
    expect(steps[3].env.HEAD_REF).toMatch(/^\$\{\{ github\.head_ref \}\}$/u);
    expect(steps[3].run).toContain('--branch "$HEAD_REF"');
  });

  it("renders the Claude settings snippet and the Codex hooks as valid JSON", () => {
    const snippet = JSON.parse(renderClaudeSettingsSnippet(".visp/hooks/claude-pretooluse.mjs"));
    expect(snippet.hooks.PreToolUse).toHaveLength(1);

    const codex = JSON.parse(renderCodexHooks());
    expect(Object.keys(codex.hooks).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
  });
});

describe("isCurrentGeneratedHook", () => {
  it("reads back the CLI path each hook embeds, quotes and spaces included", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visp it's here "));
    try {
      const cli = join(directory, 'cli "x".js');
      await copyFile(runtimeIdentity().executable, cli);
      const preCommit = (path: string) => renderPreCommitHook(true, path);
      expect(isCurrentGeneratedHook(preCommit(cli), preCommit)).toBe(true);
      expect(isCurrentGeneratedHook(renderPreToolUseHook(cli), renderPreToolUseHook)).toBe(true);
      // The chained form is a different hook, not the same one at another path.
      expect(isCurrentGeneratedHook(renderPreCommitHook(false, cli), preCommit)).toBe(false);
      expect(isCurrentGeneratedHook("#!/bin/sh\nexit 0\n", preCommit)).toBe(false);
      await rm(cli);
      expect(isCurrentGeneratedHook(preCommit(cli), preCommit)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * The hook only accepts guard answers from this build, so a hook whose path now holds
   * another build (or any other script) would refuse every check while doctor reported it
   * healthy. The same build's entry file is byte-identical: its chunk names are content hashes.
   */
  it("rejects a hook whose embedded CLI is not this build's entry file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "visp-other-build-"));
    try {
      const cli = join(directory, "cli.js");
      const preCommit = (path: string) => renderPreCommitHook(true, path);
      const own = await readFile(runtimeIdentity().executable, "utf8");
      await writeFile(cli, own.replace(/chunk-[A-Z0-9]+\.js/, "chunk-OTHERBLD.js"));
      expect(isCurrentGeneratedHook(preCommit(cli), preCommit)).toBe(false);
      await writeFile(cli, 'console.log(JSON.stringify({ command: "guard", ok: true }));\n');
      expect(isCurrentGeneratedHook(renderPreToolUseHook(cli), renderPreToolUseHook)).toBe(false);
      await writeFile(cli, own);
      expect(isCurrentGeneratedHook(preCommit(cli), preCommit)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
