import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import {
  renderCiWorkflow,
  renderClaudeSettingsSnippet,
  renderCodexHooks,
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
