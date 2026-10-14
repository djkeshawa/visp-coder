import { afterEach, describe, expect, it } from "vitest";
import { foreignHostFile } from "../../../../src/workflow/product/byproducts.js";
import { runProductVerify } from "../../../../src/workflow/product/index.js";
import type { ProductBrief } from "../../../../src/workflow/product/model.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.destroy();
});

async function claudeCode(workspace: TestWorkspace): Promise<WorkspaceState> {
  const state = await workspace.state();
  return { ...state, config: { ...state.config, harness: "claude-code" } };
}

async function paths(workspace: TestWorkspace, brief: ProductBrief) {
  const snapshot = await productSourceSnapshot(await claudeCode(workspace), brief);
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  return Object.keys(snapshot.value);
}

describe("another coding host's files", () => {
  it("are recognized only when untracked and not the configured host's own", () => {
    const none = { named: [], guarded: [] };
    for (const path of ["AGENTS.md", ".codex/hooks.json", ".agents/skills/x/SKILL.md", "GEMINI.md"])
      expect(foreignHostFile(path, false, "claude-code", none), path).toBe(true);
    for (const path of ["CLAUDE.md", ".claude/settings.json", "src/AGENTS.md", "docs/agents.md"])
      expect(foreignHostFile(path, false, "claude-code", none), path).toBe(false);
    expect(foreignHostFile("AGENTS.md", true, "claude-code", none)).toBe(false);
    expect(foreignHostFile("AGENTS.md", false, "codex", none)).toBe(false);
    expect(foreignHostFile(".claude/settings.json", false, "codex", none)).toBe(true);
    expect(foreignHostFile("AGENTS.md", false, "generic", none)).toBe(false);
    const named = (patterns: string[]) => ({ named: patterns, guarded: [] });
    expect(foreignHostFile("AGENTS.md", false, "claude-code", named(["AGENTS.md"]))).toBe(false);
    expect(foreignHostFile(".codex/hooks.json", false, "claude-code", named([".codex/**"]))).toBe(
      false,
    );
    expect(
      foreignHostFile(".codex/hooks.json", false, "claude-code", {
        named: [],
        guarded: ["**/.codex/**"],
      }),
    ).toBe(false);
    // A catch-all or extension pattern does not name another host's file.
    for (const pattern of ["**", "**/*", "*", "./**", "./**/*", "**/*.md", "*.md"])
      expect(foreignHostFile("AGENTS.md", false, "claude-code", named([pattern])), pattern).toBe(
        true,
      );
    expect(
      foreignHostFile(".codex/sub/x.toml", false, "claude-code", named([".codex/*.json"])),
    ).toBe(true);
  });

  // A desktop app importing the project wrote these mid-run; `visp done` then failed with a
  // scope violation and an earlier acceptance went stale.
  it("leave the product identity and slice scope alone when another app writes them", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const before = await paths(workspace, brief);
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    // Authorization runs under the installed host; the checks below read the files as Claude Code's.
    const work = await runProductWork(await workspace.state());
    if (!work.ok) throw new Error(work.error.message);
    await workspace.write("AGENTS.md", "# Imported instructions\n");
    await workspace.write(".codex/hooks.json", "{}\n");
    await workspace.write(".agents/skills/visp/SKILL.md", "imported\n");
    expect(await paths(workspace, brief)).toEqual(before);
    const verified = await runProductVerify(await claudeCode(workspace));
    expect(verified).toMatchObject({ ok: true, value: { passed: true } });
  });

  // A request to write an AGENTS.md puts it in the slice scope; a forbidden or blocked one
  // must reach the scope check.
  it("stay product when a slice scope names them or the configuration blocks them", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    await workspace.write("AGENTS.md", "# Requested instructions\n");
    await workspace.write(".codex/config.toml", "model = 'x'\n");
    await workspace.write("GEMINI.md", "# Imported\n");
    expect(await paths(workspace, brief)).not.toContain("AGENTS.md");
    const scoped = (scope: Partial<ProductBrief["slices"][number]["scope"]>) => ({
      ...brief,
      slices: brief.slices.map((slice) => ({ ...slice, scope: { ...slice.scope, ...scope } })),
    });
    const allowed = await paths(workspace, scoped({ allowed: ["src/value.mjs", "AGENTS.md"] }));
    expect(allowed).toContain("AGENTS.md");
    expect(allowed).not.toContain("GEMINI.md");
    expect(await paths(workspace, scoped({ expected: ["AGENTS.md"] }))).toContain("AGENTS.md");
    expect(await paths(workspace, scoped({ forbidden: [".codex/**"] }))).toContain(
      ".codex/config.toml",
    );
    const state = await claudeCode(workspace);
    const blocked = await productSourceSnapshot(
      {
        ...state,
        config: {
          ...state.config,
          workflow: { ...state.config.workflow, blockedPaths: ["GEMINI.md"] },
        },
      },
      brief,
    );
    if (!blocked.ok) throw new Error(blocked.error.message);
    expect(Object.keys(blocked.value)).toContain("GEMINI.md");
  });

  // The light path's catch-all scope says nothing about another host's files.
  it("are skipped under a catch-all slice scope", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    await workspace.write("AGENTS.md", "# Imported\n");
    await workspace.write(".codex/config.toml", "model = 'x'\n");
    for (const allowed of [["**"], ["**/*"], ["./**"], ["*", "src/**", "test/**"]]) {
      const listed = await paths(workspace, {
        ...brief,
        slices: brief.slices.map((slice) => ({ ...slice, scope: { ...slice.scope, allowed } })),
      });
      expect(listed, allowed.join()).not.toContain("AGENTS.md");
      expect(listed, allowed.join()).not.toContain(".codex/config.toml");
      expect(listed, allowed.join()).toContain("src/value.mjs");
    }
  });

  it("stay product once committed", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    await workspace.write("AGENTS.md", "# Shared instructions\n");
    workspace.commit("add shared agent instructions");
    expect(await paths(workspace, brief)).toContain("AGENTS.md");
  });
});

describe("a declared check image", () => {
  it("stays in the product identity when it is committed", async () => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const declared = {
      ...brief,
      checks: brief.checks.map((check) => ({ ...check, images: ["art/scene.png"] })),
    };
    await workspace.write("art/scene.png", "committed picture");
    expect(await paths(workspace, declared)).not.toContain("art/scene.png");
    workspace.commit("commit the picture");
    expect(await paths(workspace, declared)).toContain("art/scene.png");
  });
});
