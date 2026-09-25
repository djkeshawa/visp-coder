import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyFileTransaction, type FileMutation } from "../../../src/core/file-transaction.js";
import { ok } from "../../../src/core/result.js";
import { installHarness, previewHarnessInstall } from "../../../src/harness/install.js";
import { createProductFeature } from "../../../src/workflow/product/brief.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace.destroy();
});

describe("installation preview", () => {
  it.each([
    { critic: undefined, expected: { harness: "codex" }, enabled: true },
    {
      critic: "  enabled: false # user choice\n",
      expected: { harness: "codex", enabled: false },
      enabled: false,
    },
    {
      critic: "  model: custom-critic # keep this model\n",
      expected: { harness: "codex", model: "custom-critic" },
      enabled: true,
    },
    {
      critic: "  harness: claude-code # chosen reviewer\n",
      expected: { harness: "claude-code" },
      enabled: true,
    },
  ])(
    "preserves the legacy reviewer intent through a generic fallback: $expected",
    async ({ critic, expected, enabled }) => {
      const source = `# User-owned settings\nharness: codex # installed host\nprofile: minimal\n${critic ? `critic:\n${critic}` : ""}`;
      await workspace.write("visp.yml", source);
      const state = await workspace.state();
      const options = {
        harness: "generic" as const,
        hooks: [],
        mcp: false,
        configUpdates: { harness: "generic" as const },
      };
      const before = await snapshot(workspace.root);
      const preview = await previewHarnessInstall(state.paths, options);
      expect(preview.ok).toBe(true);
      expect(await snapshot(workspace.root)).toEqual(before);
      const steps = preview.ok ? preview.value.manualSteps.join(" ") : "";
      expect(steps.includes("The critic remains enabled")).toBe(enabled);
      if (enabled) expect(steps).toContain("does not establish that reviewer's capabilities");
      const installed = await installHarness(state.paths, options);
      expect(installed.ok).toBe(true);
      const saved = await readFile(state.paths.config, "utf8");
      expect(parse(saved)).toMatchObject({ harness: "generic", critic: expected });
      expect(parse(saved).critic).toEqual(expected);
      expect(saved).toContain("# User-owned settings");
      expect(saved).toContain("# installed host");
      if (critic?.includes("# user choice")) expect(saved).toContain("# user choice");
      if (critic?.includes("# keep this model")) expect(saved).toContain("# keep this model");
      const repeated = await previewHarnessInstall(state.paths, options);
      expect(repeated.ok && repeated.value.changes).toEqual([]);
      expect(await readFile(state.paths.config, "utf8")).toBe(saved);
    },
  );

  it.each(["codex", "generic"] as const)(
    "preserves Claude assets while explaining the Git hook still needed by %s",
    async (harness) => {
      const state = await workspace.state();
      const options = { harness, hooks: ["claude" as const], configUpdates: { harness } };
      const before = await snapshot(workspace.root);
      const preview = await previewHarnessInstall(state.paths, options);
      expect(preview.ok).toBe(true);
      expect(preview.ok && preview.value.requirements.join(" ")).toContain(
        `Claude edit hooks do not enforce scope for the selected ${harness} harness`,
      );
      expect(preview.ok && preview.value.requirements.join(" ")).toContain(
        "visp install --hooks git",
      );
      expect(await snapshot(workspace.root)).toEqual(before);
      const installed = await installHarness(state.paths, options, {
        guardHandshake: async () => ok(undefined),
      });
      expect(installed.ok).toBe(true);
      expect(installed.ok && installed.value.requirements.join(" ")).toContain(
        "An installed Git hook is still required",
      );
      expect(
        await readFile(join(workspace.root, ".visp/hooks/claude-pretooluse.mjs"), "utf8"),
      ).toContain("visp");
      workspace.commit("reviewed cross-harness installation");
      const feature = await createProductFeature(await workspace.state(), {
        goal: "Create a game",
      });
      expect(feature).toMatchObject({
        ok: false,
        error: {
          code: "STAGE_BLOCKED",
          details: { mayEdit: false, blockers: [{ requirement: "enforcement" }] },
        },
      });
    },
  );

  it("shows the same exact paths as installation without changing project or Git bytes", async () => {
    const state = await workspace.state();
    const options = {
      harness: "codex" as const,
      hooks: ["git" as const],
      mcp: true,
      configUpdates: { harness: "codex" as const },
    };
    await workspace.write("unrelated.txt", "preserve my pending work\n");
    const before = await snapshot(workspace.root);
    const result = await previewHarnessInstall(state.paths, options);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({
      dryRun: true,
      hasBaseline: true,
      repositoryAvailable: true,
      localEnforcement: "requested",
    });
    expect(result.value.changedFiles).toContain("unrelated.txt");
    expect(result.value.changes.map((change) => change.path)).toContain(".git/hooks/pre-commit");
    expect(await snapshot(workspace.root)).toEqual(before);
    let applied: readonly FileMutation[] = [];
    const installed = await installHarness(state.paths, options, {
      applyTransaction: async (root, label, mutations) => {
        applied = mutations;
        return applyFileTransaction(root, label, mutations);
      },
      guardHandshake: async () => ok(undefined),
    });
    expect(installed.ok).toBe(true);
    expect(result.value.changes.map((change) => change.path)).toEqual(
      applied.map((change) => state.paths.relative(change.path) ?? change.path),
    );
    expect(await readFile(join(workspace.root, "unrelated.txt"), "utf8")).toBe(
      "preserve my pending work\n",
    );
    const repeated = await previewHarnessInstall(state.paths, options);
    expect(repeated.ok && repeated.value.changes).toEqual([]);
  });

  it.each([{ hooks: [] }, { hooks: ["ci" as const] }])(
    "does not claim local authorization when hooks are $hooks",
    async ({ hooks }) => {
      const state = await workspace.state();
      const result = await previewHarnessInstall(state.paths, { harness: "generic", hooks });
      expect(result.ok && result.value.localEnforcement).toBe("omitted");
      expect(result.ok && result.value.requirements.join(" ")).toContain("cannot authorize coding");
      const installed = await installHarness(state.paths, { harness: "generic", hooks });
      expect(installed.ok && installed.value.requirements.join(" ")).toContain(
        "cannot authorize coding",
      );
    },
  );

  it("reports missing baseline, existing changes and omitted hooks together", async () => {
    const state = await workspace.state();
    workspace.git("update-ref", "-d", "HEAD");
    const result = await previewHarnessInstall(state.paths, { harness: "generic", hooks: [] });
    expect(result.ok && result.value.hasBaseline).toBe(false);
    expect(result.ok && result.value.requirements.join(" ")).toContain(
      "first committed project baseline",
    );
    expect(result.ok && result.value.requirements.join(" ")).toContain("changed file(s)");
    expect(result.ok && result.value.requirements.join(" ")).toContain("cannot authorize coding");
  });

  it("preserves malformed Git metadata and includes subsequent setup requirements", async () => {
    const state = await workspace.state();
    await rm(join(workspace.root, ".git/HEAD"));
    const before = await snapshot(workspace.root);
    const result = await previewHarnessInstall(state.paths, { harness: "generic", hooks: ["git"] });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STAGE_BLOCKED",
        details: {
          gitMetadataPresent: true,
          mayEdit: false,
          requirements: expect.arrayContaining([
            expect.stringContaining("first committed project baseline"),
          ]),
        },
      },
    });
    expect(await snapshot(workspace.root)).toEqual(before);
  });

  it("preserves a foreign hook and reports the conflicting planned path", async () => {
    const state = await workspace.state();
    await writeFile(join(workspace.root, ".git/hooks/pre-commit"), "#!/bin/sh\necho mine\n");
    const before = await snapshot(workspace.root);
    const result = await previewHarnessInstall(state.paths, { harness: "codex", hooks: ["git"] });
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("foreign pre-commit hook"),
        details: {
          requirements: expect.arrayContaining([expect.stringContaining("Complete installation")]),
        },
      },
    });
    expect(await snapshot(workspace.root)).toEqual(before);
  });
});

async function snapshot(root: string, path = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, child));
    else files[child] = (await readFile(join(root, child))).toString("base64");
  }
  return files;
}
