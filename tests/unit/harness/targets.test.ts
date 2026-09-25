import { describe, expect, it } from "vitest";
import { HARNESSES } from "../../../src/core/constants.js";
import { commandGuide } from "../../../src/harness/command-guide.js";
import {
  HOOK_MARKER,
  renderClaudeSettingsSnippet,
  renderPreCommitHook,
  renderPreToolUseHook,
} from "../../../src/harness/hooks.js";
import { planFor } from "../../../src/harness/targets.js";

describe("planFor", () => {
  it("produces assets for every supported harness", () => {
    for (const harness of HARNESSES) {
      const plan = planFor(harness);
      expect(plan.harness).toBe(harness);
      expect(plan.assets.length).toBeGreaterThan(0);
    }
  });

  it("gives every harness the shared agent guide", () => {
    for (const harness of HARNESSES) {
      const paths = planFor(harness).assets.map((asset) => asset.path);
      expect(paths).toContain("AGENTS.visp.md");
    }
  });

  it("offers CLI navigation when a generic install has no MCP registration", () => {
    const guide = planFor("generic", "standard").assets.find(
      (asset) => asset.path === "AGENTS.visp.md",
    )?.content;
    expect(guide).toContain("MCP tools when connected");
    expect(guide).toContain("otherwise use CLI `visp next`");
  });

  it("uses each harness's own convention", () => {
    expect(planFor("claude-code").assets.map((asset) => asset.path)).toContain(
      ".claude/commands/visp-next.md",
    );
    expect(planFor("copilot").assets.map((asset) => asset.path)).toContain(
      ".github/instructions/visp.instructions.md",
    );
    expect(planFor("cursor").assets.map((asset) => asset.path)).toContain(".cursor/rules/visp.mdc");
    expect(planFor("codex").assets.map((asset) => asset.path)).toContain(
      ".agents/skills/visp/SKILL.md",
    );
    expect(planFor("opencode").assets.map((asset) => asset.path)).toContain(
      ".agents/skills/visp/SKILL.md",
    );
  });

  it("writes only repository-relative paths", () => {
    for (const harness of HARNESSES) {
      for (const asset of planFor(harness).assets) {
        expect(asset.path.startsWith("/")).toBe(false);
        expect(asset.path).not.toContain("..");
      }
    }
  });

  it("tells every agent the scope rule", () => {
    for (const harness of HARNESSES) {
      const guide = planFor(harness)
        .assets.map((asset) => asset.content)
        .join("\n");
      expect(guide).toContain("visp work");
      expect(guide).toContain("Before the final answer");
      expect(guide).toContain("visp next");
    }
  });

  it("explains source versus delivery without making every project adopt a build step", () => {
    for (const harness of HARNESSES) {
      const guidance = planFor(harness, "standard")
        .assets.map((asset) => asset.content)
        .join("\n");

      expect(guidance, harness).toContain("self-contained artifact");
      expect(guidance, harness).toContain("one authored file/no build");
      expect(guidance, harness).toContain(
        "Neither delivery format nor test files establish implementation boundaries",
      );
    }
  });

  /** Claude Code loads AGENTS.visp.md and the skill; two full copies bought nothing. */
  it("never ships the full guide twice to one harness", () => {
    for (const harness of HARNESSES) {
      const contents = planFor(harness, "standard").assets.map((asset) => asset.content);
      const fullCopies = contents.filter((content) => content.includes("## The loop"));
      expect(fullCopies.length, harness).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the load-bearing rules in the always-resident pointer", () => {
    const agents = planFor("claude-code", "standard").assets.find(
      (asset) => asset.path === "AGENTS.visp.md",
    );

    expect(agents?.content).toContain("scope.allowed");
    expect(agents?.content).toContain("runnable");
    expect(agents?.content).toContain("execution refusals");
    expect(agents?.content).toContain("Source strings and screenshots alone do not prove behavior");
    expect(agents?.content).toContain("Missing product evidence stays unresolved");
    expect(agents?.content).toContain("Before the final answer");
    expect(agents?.content).toContain("visp work");
    expect(agents?.content).toContain("visp review");
  });

  it("tells Codex to restart after its project instructions are connected", () => {
    expect(planFor("codex").manualSteps.join(" ")).toMatch(/restart/i);
  });
});

describe("the minimal profile", () => {
  it("installs only one short guide for a generic harness", () => {
    for (const harness of HARNESSES.filter((name) => name === "generic")) {
      const paths = planFor(harness, "minimal").assets.map((asset) => asset.path);
      expect(paths, harness).toEqual(["AGENTS.visp.md", "VISP.commands.md"]);
    }
  });

  it("keeps an on-demand pointer skill for Codex and OpenCode", () => {
    for (const harness of ["codex", "opencode"] as const) {
      const plan = planFor(harness, "minimal");
      expect(plan.assets.map((asset) => asset.path)).toEqual([
        "AGENTS.visp.md",
        ".agents/skills/visp/SKILL.md",
        "VISP.commands.md",
        ...(harness === "codex"
          ? [".codex/agents/visp-critic.toml", ".visp/hooks/codex-hooks.mjs", ".codex/hooks.json"]
          : []),
      ]);

      const skill = plan.assets.find((asset) => asset.path.endsWith("/SKILL.md"));
      expect(skill?.content).toContain("name: visp");
      expect(skill?.content).toContain("AGENTS.visp.md");
    }
  });

  it("keeps compact native pointers for Copilot and Cursor", () => {
    expect(planFor("copilot", "minimal").assets.map((asset) => asset.path)).toEqual([
      "AGENTS.visp.md",
      ".github/instructions/visp.instructions.md",
      "VISP.commands.md",
      ".github/agents/visp-critic.agent.md",
    ]);
    expect(planFor("cursor", "minimal").assets.map((asset) => asset.path)).toEqual([
      "AGENTS.visp.md",
      ".cursor/rules/visp.mdc",
      "VISP.commands.md",
      ".cursor/agents/visp-critic.md",
    ]);
  });

  it("keeps the loop slash command for claude-code", () => {
    const paths = planFor("claude-code", "minimal").assets.map((asset) => asset.path);
    expect(paths).toEqual([
      "AGENTS.visp.md",
      ".claude/commands/visp-next.md",
      "VISP.commands.md",
      ".claude/agents/visp-critic.md",
    ]);
  });

  it("stays under its token ceiling with every rule intact", () => {
    const guide = planFor("generic", "minimal").assets[0]?.content ?? "";

    // chars/4 as a coarse token proxy; the point is an enforced ceiling.
    expect(guide.length / 4).toBeLessThanOrEqual(300);
    expect(guide).toContain("scope.allowed");
    expect(guide).toContain("runnable");
    expect(guide).toContain("execution refusals");
    expect(guide).toContain("Source strings and screenshots alone do not prove behavior");
    expect(guide).toContain("Missing product evidence stays unresolved");
    expect(guide).toContain("Before the final answer");
  });

  it("defaults to the minimal profile", () => {
    expect(planFor("claude-code")).toEqual(planFor("claude-code", "minimal"));
  });
});

describe("generated workflow routing", () => {
  it("documents the exact bounded wait and capture budget for browser journeys", () => {
    const guide = commandGuide();
    expect(guide).toContain("durationMs");
    expect(guide).toContain("automatic initial capture");
    expect(guide).toContain("six total captures");
  });

  it.each(["standard", "minimal"] as const)(
    "routes %s UI work through direct checks and observed example coverage",
    (profile) => {
      const guide = planFor("generic", profile).assets[0]?.content ?? "";
      expect(guide).toContain('kind:"browser-journey"');
      expect(guide).toContain("Browser journeys must not mutate VISP state");
      expect(guide).toContain("visp review --prepare");
      expect(guide).toContain("--session <id> --from -");
      expect(guide).toContain("An accepted critic response records the review");
      expect(commandGuide()).toContain("No category declarations, example-coverage ledger");
      expect(guide).toContain("reviewer.context honestly");
      expect(guide).toContain("Do not force extra review rounds");
    },
  );

  it("keeps dispatch details on demand rather than repeating them in the resident guide", () => {
    const guide = planFor("generic", "standard").assets[0]?.content ?? "";
    expect(guide).toContain("VISP.commands.md");
    expect(guide).not.toContain("An attached adapter");
    expect(commandGuide()).toContain("model/effort");
    expect(commandGuide()).toContain("attached adapter");
    expect(commandGuide()).toContain("relevant --group");
    expect(commandGuide()).toContain("compact recording receipt; --detail");
  });

  it.each(["standard", "minimal"] as const)(
    "uses one brief and work operation without imposing legacy stages in the %s guide",
    (profile) => {
      const guide = planFor("generic", profile).assets[0]?.content ?? "";

      expect(guide).toContain("visp brief");
      expect(guide).toContain("visp work");
      expect(guide).toContain("VISP generates");
      expect(guide).not.toContain("visp research --validate");
      expect(guide).not.toContain("compact workflow");
    },
  );

  it.each(["standard", "minimal"] as const)(
    "routes the %s guide through product feedback and final acceptance",
    (profile) => {
      const guide = planFor("generic", profile).assets[0]?.content ?? "";

      expect(guide).toContain("visp done");
      expect(guide).toContain("visp next");
      expect(guide).toContain("visp accept");
      expect(guide).toContain("Run `visp accept` only when `visp next` directs it");
      expect(guide).toContain("Missing product evidence stays unresolved");
    },
  );

  it("documents explicit final acceptance in the shared command guide", () => {
    const guide = commandGuide();
    expect(guide).toContain("`visp accept --feature <id>`");
    expect(guide).toContain("`visp next` only reports the next action");
  });

  it("does not hard-code research into the feature slash command", () => {
    const featureCommand = planFor("claude-code", "standard").assets.find(
      (asset) => asset.path === ".claude/commands/visp-feature.md",
    );

    expect(featureCommand?.content).toContain("first usable slice");
    expect(featureCommand?.content).not.toContain("through research");
  });
});

describe("hook templates", () => {
  it("marks generated files so install never clobbers a foreign hook", () => {
    expect(renderPreToolUseHook()).toContain(`// ${HOOK_MARKER}`);
    expect(renderPreCommitHook()).toContain(`# ${HOOK_MARKER}`);
  });

  it("comments the marker validly for each file's language", () => {
    // A shell-style comment inside JavaScript would be a syntax error.
    const hookLines = renderPreToolUseHook().split("\n");
    expect(hookLines.some((line) => line.trim().startsWith("#!"))).toBe(true);
    expect(hookLines.filter((line) => line.trim().startsWith("# "))).toEqual([]);
  });

  it("delegates the decision to visp guard rather than reimplementing it", () => {
    expect(renderPreToolUseHook()).toContain('"guard"');
    expect(renderPreCommitHook()).toContain("guard --staged");
  });

  it("fails closed on an unchecked active authorization", () => {
    const hook = renderPreCommitHook();

    expect(hook).toContain("command -v visp");
    expect(hook).toContain("implement-allowed");
    expect(hook).toContain(process.execPath);
    expect(hook).not.toContain("Committing anyway");
  });

  /**
   * Exit codes cannot carry this decision: another program named `visp` on PATH
   * exits 1 for its own reasons, and 1 is also the refusal code. Only a
   * parseable guard envelope proves the check actually ran.
   */
  it("decides from the guard envelope, not from the exit code", () => {
    const hook = renderPreCommitHook();

    expect(hook).toContain("--json");
    expect(hook).toContain('parsed?.command === "guard"');
    expect(hook).toContain("data?.protocolVersion === 2");
    expect(hook).toContain("unchecked");
    expect(hook).toContain("could not check this commit");
    expect(hook).not.toContain("status=$?");
  });

  it("matches the editing tools in the Claude settings snippet", () => {
    const snippet = JSON.parse(renderClaudeSettingsSnippet(".visp/hooks/claude-pretooluse.mjs"));
    const matcher = snippet.hooks.PreToolUse[0].matcher;
    expect(matcher).toContain("Edit");
    expect(matcher).toContain("Write");
  });
});
