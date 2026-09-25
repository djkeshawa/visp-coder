import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { vispError } from "../../../src/core/errors.js";
import { err, ok } from "../../../src/core/result.js";
import { type InstallRuntime, installHarness } from "../../../src/harness/install.js";
import { CODEX_CONFIG_FILE } from "../../../src/harness/mcp-registration.js";
import { TestWorkspace } from "../support/workspace.js";

describe("post-install verification", () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await TestWorkspace.create();
  });

  afterEach(async () => {
    await workspace.destroy();
  });

  it("accepts an exact install across every requested surface", async () => {
    const handshake = vi.fn(async () => ok(undefined));
    const result = await installCodex({ hooks: ["git"], mcp: true }, { guardHandshake: handshake });

    expect(result.ok).toBe(true);
    expect(handshake).toHaveBeenCalledOnce();
  });

  it("accepts a generated Codex critic agent with an explicit model and effort", async () => {
    await configureCodexCritic();

    const result = await installCodex({ hooks: [], mcp: false }, {});

    expect(result.ok).toBe(true);
    const agent = await readFile(join(workspace.root, ".codex/agents/visp-critic.toml"), "utf8");
    expect(agent).toContain('model = "gpt-6-astra"');
    expect(agent).toContain('model_reasoning_effort = "low"');
  });

  it("rejects a tampered generated Codex critic agent after a custom install", async () => {
    await configureCodexCritic();

    const result = await installCodex(
      { hooks: [], mcp: false },
      {
        afterApply: () =>
          workspace.write(
            ".codex/agents/visp-critic.toml",
            'name = "visp-critic"\nmodel = "tampered"\n',
          ),
      },
    );

    expectMismatch(result, "generated asset", ".codex/agents/visp-critic.toml");
  });

  it("returns a structured failure when an installed asset changes before verification", async () => {
    const result = await installCodex(
      { hooks: [], mcp: false },
      {
        afterApply: () => workspace.write("AGENTS.visp.md", "stale generated guide\n"),
      },
    );

    expectMismatch(result, "generated asset", "AGENTS.visp.md");
  });

  it("returns a structured failure when the post-commit verification seam fails", async () => {
    const result = await installCodex(
      { hooks: [], mcp: false },
      {
        afterApply: () => {
          throw new Error("injected post-commit failure");
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("IO_ERROR");
      expect(result.error.message).toContain("injected post-commit failure");
    }
  });

  it("returns a structured failure when required activation changes before verification", async () => {
    const result = await installCodex(
      { hooks: [], mcp: false },
      {
        afterApply: async () => {
          const agents = join(workspace.root, "AGENTS.md");
          const current = await readFile(agents, "utf8");
          await writeFile(
            agents,
            current.replace(
              "Follow the VISP project instructions",
              "Ignore the VISP project instructions",
            ),
            "utf8",
          );
        },
      },
    );

    expectMismatch(result, "harness activation", "AGENTS.md");
  });

  it.skipIf(process.platform === "win32")(
    "returns a structured failure when a requested hook loses executable mode",
    async () => {
      const result = await installCodex(
        { hooks: ["git"], mcp: false },
        {
          afterApply: () => chmod(join(workspace.root, ".git/hooks/pre-commit"), 0o644),
          guardHandshake: async () => ok(undefined),
        },
      );

      expectMismatch(result, "generated executable", ".git/hooks/pre-commit");
    },
  );

  it("returns a structured failure when requested Claude hook wiring changes", async () => {
    const state = await workspace.state();
    const result = await installHarness(
      state.paths,
      { harness: "claude-code", profile: state.config.profile, hooks: ["claude"], mcp: false },
      {
        afterApply: () => workspace.write(".claude/settings.json", "{}\n"),
        guardHandshake: async () => ok(undefined),
      },
    );

    expectMismatch(result, "Claude hook registration", ".claude/settings.json");
  });

  it("returns a structured failure when a requested MCP registration changes", async () => {
    const result = await installCodex(
      { hooks: [], mcp: true },
      {
        afterApply: () => workspace.write(CODEX_CONFIG_FILE, "[mcp_servers.visp]\n"),
        guardHandshake: async () => ok(undefined),
      },
    );

    expectMismatch(result, "MCP registration", CODEX_CONFIG_FILE);
  });

  it.each([
    {
      surface: "install state",
      path: ".visp/state/install.json",
      content:
        '{"kind":"install-state","version":1,"harness":"generic","profile":"minimal","hooks":[],"mcp":false}\n',
    },
    {
      surface: "configuration",
      path: "visp.yml",
      content: "harness: generic\nprofile: minimal\n",
    },
    {
      surface: "asset manifest",
      path: ".visp/state/asset-manifest.json",
      content: "{}\n",
    },
  ])("returns a structured failure when $surface changes", async ({ surface, path, content }) => {
    const result = await installCodex(
      { hooks: [], mcp: false },
      { afterApply: () => workspace.write(path, content) },
    );

    expectMismatch(result, surface, path);
  });

  it.each([
    { surface: "install state", path: ".visp/state/install.json" },
    { surface: "asset manifest", path: ".visp/state/asset-manifest.json" },
  ])("rejects semantically equivalent but non-exact $surface bytes", async ({ surface, path }) => {
    const result = await installCodex(
      { hooks: [], mcp: false },
      {
        afterApply: async () => {
          const absolute = join(workspace.root, path);
          const parsed = JSON.parse(await readFile(absolute, "utf8"));
          await writeFile(absolute, JSON.stringify(parsed), "utf8");
        },
      },
    );

    expectMismatch(result, surface, path);
  });

  it("propagates a failed live guard handshake instead of reporting success", async () => {
    const handshake = vi.fn(async () =>
      err(vispError("COMMAND_FAILED", "synthetic guard is unavailable")),
    );
    const result = await installCodex(
      { hooks: ["git"], mcp: false },
      { guardHandshake: handshake },
    );

    expect(handshake).toHaveBeenCalledOnce();
    expect(result).toEqual(err(vispError("COMMAND_FAILED", "synthetic guard is unavailable")));
  });

  it("preserves explicit local-enforcement omissions without probing the executable", async () => {
    const handshake = vi.fn(async () => err(vispError("COMMAND_FAILED", "must not be called")));
    const result = await installCodex({ hooks: ["ci"], mcp: false }, { guardHandshake: handshake });

    expect(result.ok).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  it("verifies MCP registration without treating it as a live enforcement surface", async () => {
    const handshake = vi.fn(async () => err(vispError("COMMAND_FAILED", "must not be called")));
    const result = await installCodex({ hooks: [], mcp: true }, { guardHandshake: handshake });

    expect(result.ok).toBe(true);
    expect(handshake).not.toHaveBeenCalled();
  });

  async function installCodex(
    surfaces: { readonly hooks: readonly ("git" | "ci")[]; readonly mcp: boolean },
    runtime: InstallRuntime,
  ) {
    const state = await workspace.state();
    return installHarness(
      state.paths,
      {
        harness: "codex",
        profile: state.config.profile,
        hooks: surfaces.hooks,
        mcp: surfaces.mcp,
        configUpdates: { harness: "codex" },
      },
      runtime,
    );
  }

  async function configureCodexCritic(): Promise<void> {
    const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    config.critic = {
      harness: "codex",
      enabled: true,
      model: "gpt-6-astra",
      reasoningEffort: "low",
      maxCalls: 2,
      timeoutMs: 180_000,
      maxImageBytes: 4 * 1024 * 1024,
    };
    await workspace.write("visp.yml", stringify(config));
  }
});

function expectMismatch(
  result: Awaited<ReturnType<typeof installHarness>>,
  surface: string,
  path: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    code: "STAGE_BLOCKED",
    recovery: "visp doctor",
    details: { surface, path },
  });
}
