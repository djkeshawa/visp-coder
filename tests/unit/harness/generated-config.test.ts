import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
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
      await writeFile(cli, "// another install\n");
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
});
