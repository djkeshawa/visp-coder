import { mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vispError } from "../../../src/core/errors.js";
import { exists, ProjectFileSystem } from "../../../src/core/fs.js";
import { err } from "../../../src/core/result.js";
import { hookCommand } from "../../../src/harness/claude-settings.js";
import { defaultHooks, installHarness, readAssetManifest } from "../../../src/harness/install.js";
import { buildInstallPlan } from "../../../src/harness/install-plan.js";
import { CODEX_CONFIG_FILE } from "../../../src/harness/mcp-registration.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.destroy();
});

describe("transactional harness installation", () => {
  it("creates missing nested parents on the first install and stays idempotent", async () => {
    const state = await workspace.state();
    const first = await installHarness(state.paths, {
      harness: "codex",
      profile: "minimal",
      hooks: [],
      mcp: false,
    });

    expect(first.ok).toBe(true);
    expect(await exists(join(workspace.root, ".agents/skills/visp/SKILL.md"))).toBe(true);
    expect(await exists(join(workspace.root, ".codex/agents/visp-critic.toml"))).toBe(true);

    const second = await installHarness(state.paths, {
      harness: "codex",
      profile: "minimal",
      hooks: [],
      mcp: false,
    });

    expect(second.ok).toBe(true);
    expect(second.ok && second.value.assets.every((asset) => asset.status === "unchanged")).toBe(
      true,
    );
  });

  it("works when recursive mkdir cannot span multiple missing parent components", async () => {
    const state = await workspace.state();
    const original = ProjectFileSystem.prototype.ensureDir;
    vi.spyOn(ProjectFileSystem.prototype, "ensureDir").mockImplementation(async function (
      this: ProjectFileSystem,
      path,
    ) {
      const relativePath = relative(workspace.root, path);
      if (
        !relativePath.startsWith(`..${sep}`) &&
        relativePath.split(sep).length > 1 &&
        !(await exists(dirname(path)))
      ) {
        return err(
          vispError("IO_ERROR", `ENOENT: no such file or directory, mkdir '${relativePath}'`),
        );
      }
      return original.call(this, path);
    });

    const result = await installHarness(state.paths, {
      harness: "codex",
      profile: "minimal",
      hooks: [],
      mcp: false,
    });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.ok).toBe(true);
    expect(await exists(join(workspace.root, ".agents/skills/visp/SKILL.md"))).toBe(true);
    expect(await exists(join(workspace.root, ".codex/agents/visp-critic.toml"))).toBe(true);
  });

  it("refuses a reviewer policy changed between planning reads without writing assets", async () => {
    await workspace.write("visp.yml", "harness: codex\ncritic:\n  enabled: true\n");
    const state = await workspace.state();
    const original = state.files.readTextIfExists.bind(state.files);
    let reads = 0;
    const concurrent = "harness: codex\ncritic:\n  enabled: false # concurrent user choice\n";
    vi.spyOn(state.files, "readTextIfExists").mockImplementation(async (path) => {
      if (path === state.paths.config && ++reads === 2) await writeFile(path, concurrent);
      return original(path);
    });
    const result = await buildInstallPlan(
      state.paths,
      { harness: "generic", hooks: [], mcp: false, configUpdates: { harness: "generic" } },
      "minimal",
      state.files,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "IO_ERROR", message: expect.stringContaining("Configuration changed") },
    });
    expect(await readFile(state.paths.config, "utf8")).toBe(concurrent);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    expect(await exists(state.paths.installState)).toBe(false);
  });

  it.each([
    "EACCES: permission denied, mkdir '.agents/skills'",
    "EPERM: operation not permitted, open '.codex/agents/visp-critic.toml'",
    "EROFS: read-only file system, mkdir '.agents/skills'",
    "ENOENT: no such file or directory, open '.agents/skills/visp/SKILL.md'",
  ])("preserves the requested host and rolls back a restricted install: %s", async (message) => {
    const state = await workspace.state();
    const originalConfig = await readFile(state.paths.config, "utf8");
    const write = ProjectFileSystem.prototype.writeBytesAtomic;
    const blocked = vi
      .spyOn(ProjectFileSystem.prototype, "writeBytesAtomic")
      .mockImplementation(function (this: ProjectFileSystem, path, bytes, mode) {
        return path.includes(".agents/skills/")
          ? Promise.resolve(err(vispError("IO_ERROR", message)))
          : write.call(this, path, bytes, mode);
      });
    const result = await installHarness(state.paths, {
      harness: "codex",
      profile: "standard",
      hooks: [],
      mcp: false,
      configUpdates: { harness: "codex" },
    });
    blocked.mockRestore();
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "IO_ERROR",
        message: expect.stringContaining("host's permission approval flow"),
        details: {
          installationRecovery: {
            harness: "codex",
            retry: "visp install --harness codex --profile standard --no-hooks --no-mcp",
            setupIncomplete: true,
          },
        },
      },
    });
    if (!result.ok) {
      expect(result.error.message).toContain(message);
      expect(result.error.message).toContain("generic omits host-specific integration");
      expect(result.error.message).toContain("does not satisfy an enabled critic requirement");
    }
    expect(await readFile(state.paths.config, "utf8")).toBe(originalConfig);
    expect(await exists(state.paths.installState)).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    expect(await exists(join(workspace.root, ".agents"))).toBe(false);
    expect(await exists(join(workspace.root, ".codex"))).toBe(false);
  });

  it("removes newly created nested parents when a later asset fails", async () => {
    const state = await workspace.state();
    const write = ProjectFileSystem.prototype.writeBytesAtomic;
    const blocked = vi
      .spyOn(ProjectFileSystem.prototype, "writeBytesAtomic")
      .mockImplementation(function (this: ProjectFileSystem, path, bytes, mode) {
        return path.includes(".codex/agents/")
          ? Promise.resolve(err(vispError("IO_ERROR", "injected nested asset failure")))
          : write.call(this, path, bytes, mode);
      });

    const result = await installHarness(state.paths, {
      harness: "codex",
      profile: "minimal",
      hooks: [],
      mcp: false,
    });

    blocked.mockRestore();
    expect(result.ok).toBe(false);
    expect(await exists(join(workspace.root, ".agents"))).toBe(false);
    expect(await exists(join(workspace.root, ".codex"))).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
  });

  it("refuses a hostile nested parent symlink before creating any asset", async () => {
    const state = await workspace.state();
    await symlink("/tmp", join(workspace.root, ".agents"), "dir");

    const result = await installHarness(state.paths, {
      harness: "codex",
      profile: "minimal",
      hooks: [],
      mcp: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("symlink component");
    expect(await readlink(join(workspace.root, ".agents"))).toBe("/tmp");
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
  });

  it("retains transaction recovery instructions before a permission-related retry", async () => {
    const state = await workspace.state();
    const result = await installHarness(
      state.paths,
      {
        harness: "codex",
        hooks: ["git", "ci"],
        mcp: true,
        force: true,
        prunePreviousHarness: true,
      },
      {
        applyTransaction: async () =>
          err(
            vispError("IO_ERROR", "EACCES: permission denied; rollback also failed", {
              recovery: "Run visp doctor --fix before making more changes",
              details: { transaction: "pending-transaction" },
            }),
          ),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        recovery: "Run visp doctor --fix before making more changes",
        details: {
          transaction: "pending-transaction",
          installationRecovery: {
            retry:
              "visp install --harness codex --profile minimal --hooks git ci --force --prune-previous-harness",
          },
        },
      },
    });
  });

  it.each([
    "Refusing project path with symlink component: .agents",
    "Concurrent change detected while updating .agents/skills/visp/SKILL.md",
    "ENOENT: no such file or directory, open 'unrelated.txt'",
  ])(
    "does not reframe a safety or unrelated failure as a permission issue: %s",
    async (message) => {
      const state = await workspace.state();
      const failure = vispError("IO_ERROR", message);
      const result = await installHarness(
        state.paths,
        { harness: "codex", hooks: [], mcp: false },
        { applyTransaction: async () => err(failure) },
      );
      expect(result).toEqual(err(failure));
    },
  );

  it("refuses a manifest edited between planning reads without writing any assets", async () => {
    const state = await workspace.state();
    const original = state.files.readTextIfExists.bind(state.files);
    let reads = 0;
    const concurrent = '{"project-owned.md":"concurrent-fingerprint"}\n';
    vi.spyOn(state.files, "readTextIfExists").mockImplementation(async (path) => {
      if (path === state.paths.assetManifest && ++reads === 2) await writeFile(path, concurrent);
      return original(path);
    });
    const result = await buildInstallPlan(
      state.paths,
      { harness: "codex", hooks: [], mcp: false },
      "standard",
      state.files,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "IO_ERROR", message: expect.stringContaining("manifest changed") },
    });
    expect(await readFile(state.paths.assetManifest, "utf8")).toBe(concurrent);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.md"))).toBe(false);
  });

  it.each([
    { name: "malformed", content: "{not-json", message: "could not be safely merged" },
    {
      name: "customized",
      content: JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [
                { type: "command", command: hookCommand(".visp/hooks/claude-pretooluse.mjs") },
              ],
            },
          ],
        },
      }),
      message: "edited VISP hook registration",
    },
  ])(
    "preserves the whole project when required Claude hook settings are $name",
    async ({ content, message }) => {
      const state = await workspace.state();
      await workspace.write(".claude/settings.json", content);
      const originalConfig = await readFile(state.paths.config, "utf8");
      const result = await installHarness(state.paths, {
        harness: "claude-code",
        hooks: ["claude"],
        mcp: false,
        configUpdates: { harness: "claude-code", profile: "standard" },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_INVALID", message: expect.stringContaining(message) },
      });
      expect(await readFile(join(workspace.root, ".claude/settings.json"), "utf8")).toBe(content);
      expect(await readFile(state.paths.config, "utf8")).toBe(originalConfig);
      expect(await exists(state.paths.assetManifest)).toBe(false);
      expect(await exists(join(workspace.root, ".visp/hooks/claude-pretooluse.mjs"))).toBe(false);
      expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    },
  );

  it("uses harness-appropriate local enforcement defaults", () => {
    expect(defaultHooks("claude-code")).toEqual(["claude", "git"]);
    expect(defaultHooks("codex")).toEqual(["git"]);
  });

  it("refuses a requested Git hook when the project is no longer a repository", async () => {
    const state = await workspace.state();
    await rm(join(workspace.root, ".git"), { recursive: true, force: true });

    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: ["git"],
      mcp: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STAGE_BLOCKED");
  });

  it.each(["[]\n", '{"AGENTS.visp.md":42}\n'])(
    "rejects malformed asset manifest shape %s",
    async (content) => {
      const state = await workspace.state();
      await mkdir(join(workspace.root, ".visp/state"), { recursive: true });
      await writeFile(state.paths.assetManifest, content, "utf8");

      const result = await readAssetManifest(state.paths, state.files);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("ARTIFACT_INVALID");
    },
  );

  it("writes no assets or config choice when a requested MCP surface is unsafe", async () => {
    const state = await workspace.state();
    const originalConfig = await readFile(state.paths.config, "utf8");
    await mkdir(join(workspace.root, ".codex"), { recursive: true });
    await writeFile(join(workspace.root, CODEX_CONFIG_FILE), "mcp_servers = [\n", "utf8");

    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: true,
      configUpdates: { harness: "codex" },
    });

    expect(result.ok).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.md"))).toBe(false);
    expect(await exists(join(workspace.root, ".agents/skills/visp/SKILL.md"))).toBe(false);
    expect(await readFile(state.paths.config, "utf8")).toBe(originalConfig);
    expect(await readFile(join(workspace.root, CODEX_CONFIG_FILE), "utf8")).toBe(
      "mcp_servers = [\n",
    );
  });

  it("writes no planned assets when a requested Git hook conflicts", async () => {
    const state = await workspace.state();
    const hook = join(workspace.root, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\necho project-hook\n", "utf8");

    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: ["git"],
      mcp: false,
    });

    expect(result.ok).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.visp.md"))).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.md"))).toBe(false);
    expect(await readFile(hook, "utf8")).toContain("project-hook");
  });

  it("refuses an unrecognized required asset without partially installing", async () => {
    const state = await workspace.state();
    const guide = join(workspace.root, "AGENTS.visp.md");
    await writeFile(guide, "project-owned instructions\n", "utf8");

    const result = await installHarness(state.paths, {
      harness: "codex",
      hooks: [],
      mcp: false,
    });

    expect(result.ok).toBe(false);
    expect(await readFile(guide, "utf8")).toBe("project-owned instructions\n");
    expect(await exists(join(workspace.root, ".agents/skills/visp/SKILL.md"))).toBe(false);
    expect(await exists(join(workspace.root, "AGENTS.md"))).toBe(false);
  });
});
