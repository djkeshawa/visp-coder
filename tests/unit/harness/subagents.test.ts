import { describe, expect, it } from "vitest";
import { QUERY_OPERATIONS_LINE } from "../../../src/harness/instructions.js";
import { renderClaudeSubagent, SUBAGENTS } from "../../../src/harness/subagents.js";
import { planFor } from "../../../src/harness/targets.js";

describe("subagents", () => {
  it("defines implementation roles and independent read-only probes", () => {
    expect(SUBAGENTS.map((agent) => agent.name)).toEqual([
      "visp-scout",
      "visp-investigator",
      "visp-test-architect",
      "visp-skeptic",
      "visp-visual-reviewer",
      "visp-implementer",
      "visp-reviewer",
    ]);
  });

  /**
   * The scout keeps its own expanded query list — it is load-bearing inside
   * the subagent's context — but every operation the shared line names must
   * appear in it, so the two teachings cannot drift apart.
   */
  it("teaches the scout every query operation the shared rules name", () => {
    const scout = SUBAGENTS.find((agent) => agent.name === "visp-scout");
    for (const operation of QUERY_OPERATIONS_LINE.split(" | ")) {
      expect(scout?.prompt).toContain(`query ${operation}`);
    }
  });

  /** A scout that can edit is just an expensive implementer. */
  it("gives the scout no way to change files", () => {
    const scout = SUBAGENTS.find((agent) => agent.name === "visp-scout");
    expect(scout?.tools).not.toContain("Edit");
    expect(scout?.tools).not.toContain("Write");
    expect(scout?.prompt).toContain("never edit");
  });

  it("keeps the reviewer read-only too", () => {
    const reviewer = SUBAGENTS.find((agent) => agent.name === "visp-reviewer");
    expect(reviewer?.tools).not.toContain("Edit");
    expect(reviewer?.tools).not.toContain("Write");
  });

  it("keeps every probe read-only and forces evidence separation", () => {
    for (const name of [
      "visp-investigator",
      "visp-test-architect",
      "visp-skeptic",
      "visp-visual-reviewer",
    ]) {
      const probe = SUBAGENTS.find((agent) => agent.name === name);
      expect(probe?.tools).not.toContain("Edit");
      expect(probe?.tools).not.toContain("Write");
      expect(probe?.prompt).toContain("Facts");
      expect(probe?.prompt).toContain("Inferences");
      expect(probe?.prompt).toContain("Unknowns");
      expect(probe?.prompt).toContain("never edit");
    }
  });

  it("inherits the configured model for every role instead of silently changing study conditions", () => {
    expect(SUBAGENTS.every((agent) => agent.model === "inherit")).toBe(true);
  });

  it("tells the implementer to change the task rather than route around a refusal", () => {
    const implementer = SUBAGENTS.find((agent) => agent.name === "visp-implementer");
    expect(implementer?.prompt).toContain("working around the refusal");
    expect(implementer?.prompt).toContain("Do not weaken a test");
    expect(implementer?.prompt).toContain("visp next");
    expect(implementer?.prompt).toContain("do not claim completion");
    expect(implementer?.prompt).toContain("visp work");
    expect(implementer?.prompt).not.toContain("gate implement");
  });

  it("separates aesthetic judgment from visible defect detection", () => {
    const visual = SUBAGENTS.find((agent) => agent.name === "visp-visual-reviewer");

    expect(visual?.prompt).toContain("composition");
    expect(visual?.prompt).toContain("visual identity");
    expect(visual?.prompt).toContain("separate aesthetic critique");
    expect(visual?.prompt).toContain("source brief");
    expect(visual?.prompt).toContain("first viewport");
    expect(visual?.prompt).toContain("revise and recapture");
    expect(visual?.prompt).toContain("at most three consequential actionable findings");
    expect(visual?.prompt).toContain("unresolved review gap");
  });
  it("lets the read-only visual reviewer receive images without granting mutation tools", () => {
    const visual = SUBAGENTS.find((agent) => agent.name === "visp-visual-reviewer");
    expect(visual?.tools).toContain("mcp__visp__visp_observations");
    expect(visual?.tools).not.toContain("Bash");
    expect(visual?.prompt).toContain("If you cannot inspect the image, report unclear");
  });

  it("requires deterministic browser scenarios in the test architecture", () => {
    const testArchitect = SUBAGENTS.find((agent) => agent.name === "visp-test-architect");

    expect(testArchitect?.prompt).toContain("seed or freeze randomness");
    expect(testArchitect?.prompt).toContain("fresh reset");
    expect(testArchitect?.prompt).toContain("stable state");
  });

  it("describes when to use each one, so a coder can route to it", () => {
    for (const agent of SUBAGENTS) {
      expect(agent.description.length).toBeGreaterThan(40);
      expect(agent.description).toMatch(/Use (before|after|when)/);
    }
  });
});

describe("renderClaudeSubagent", () => {
  it("writes frontmatter Claude Code can read", () => {
    const scout = SUBAGENTS[0];
    if (!scout) throw new Error("expected a subagent");

    const rendered = renderClaudeSubagent(scout);
    const lines = rendered.split("\n");

    expect(lines[0]).toBe("---");
    expect(rendered).toContain(`name: ${scout.name}`);
    expect(rendered).toContain(`model: ${scout.model}`);
    expect(rendered).toContain("tools: ");
  });

  it("omits the tools line when the agent inherits everything", () => {
    const implementer = SUBAGENTS.find((agent) => agent.name === "visp-implementer");
    if (!implementer) throw new Error("expected the implementer");

    expect(renderClaudeSubagent(implementer)).not.toContain("tools:");
  });
});

describe("installing subagents", () => {
  it("ships them to Claude Code", () => {
    const paths = planFor("claude-code", "standard").assets.map((asset) => asset.path);
    expect(paths).toContain(".claude/agents/visp-scout.md");
    expect(paths).toContain(".claude/agents/visp-implementer.md");
    expect(paths).toContain(".claude/agents/visp-skeptic.md");
  });

  it("does not ship the legacy agent collection to other harnesses", () => {
    for (const harness of ["copilot", "cursor", "generic"] as const) {
      const paths = planFor(harness).assets.map((asset) => asset.path);
      expect(
        paths.filter((path) => path.includes("/agents/") && !path.includes("visp-critic")),
      ).toEqual([]);
    }
  });
});
