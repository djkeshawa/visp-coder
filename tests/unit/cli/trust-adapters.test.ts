import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRoot, workspaceWithFeature } from "../../../src/cli/context.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const app = true;\n" });
});

afterEach(async () => {
  await workspace.destroy();
});

describe("CLI trust-boundary adapters", () => {
  it("defaults the project root and rejects invalid or absent feature selections", async () => {
    expect(projectRoot({})).toBe(resolve(process.cwd()));

    const invalid = await workspaceWithFeature({
      project: workspace.root,
      feature: "../../outside",
    });
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error.code).toBe("ARTIFACT_INVALID");

    const absent = await workspaceWithFeature({ project: workspace.root });
    expect(absent.ok).toBe(false);
    expect(!absent.ok && absent.error.code).toBe("NO_ACTIVE_FEATURE");
  });

  it("installs default omissions and explicit harness choices through the CLI", async () => {
    const minimal = await runCli(workspace.root, "install", "--no-hooks", "--no-mcp");
    expect(minimal.exitCode, minimal.stderr).toBe(0);
    expect(minimal.stdout).toContain("Installed visp assets for generic");

    const explicit = await runCli(
      workspace.root,
      "install",
      "--harness",
      "codex",
      "--profile",
      "standard",
      "--hooks",
      "ci",
      "--no-mcp",
      "--prune-previous-harness",
      "--force",
    );
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    expect(explicit.stdout).toContain("Installed visp assets for codex");
    expect(explicit.stdout).toMatch(/wrote|current|removed/);
  });

  it("reports install state-loading failures in a structured envelope", async () => {
    await rm(`${workspace.root}/.visp`, { recursive: true, force: true });

    const result = await runJson(workspace.root, "install", "--no-hooks", "--no-mcp");

    expect(result.exitCode).not.toBe(0);
    expect(result.envelope.error?.code).toBe("NOT_INITIALIZED");
  });

  it("accepts a typed init harness when force-reinitializing an existing project", async () => {
    const result = await runCli(workspace.root, "init", "--harness", "codex", "--force");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Set up visp");
    expect(result.stdout).toContain("Wrote");
  });

  it("work selects explicit and active slices and refuses a closed slice", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    const explicit = await runJson<{ task: string; mayEdit: boolean }>(
      workspace.root,
      "work",
      "--task",
      "T001",
    );
    expect(explicit.envelope.data).toMatchObject({ task: "T001", mayEdit: true });
    expect((await runJson(workspace.root, "work")).exitCode).toBe(0);
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    expect((await runJson(workspace.root, "done")).exitCode).toBe(0);
    expect((await runJson(workspace.root, "work", "--task", "T001")).envelope.error?.code).toBe(
      "STAGE_BLOCKED",
    );
  });

  it("requires explicit migration before work reads old task graphs", async () => {
    await workspace.installFoundation();
    await workspace.withFeature("001-context");
    await workspace.write(".visp/features/001-context/tasks.json", "{}\n");

    const result = await runJson(workspace.root, "work", "--task", "T001");

    expect(result.exitCode).not.toBe(0);
    expect(result.envelope.error?.code).toBe("MIGRATION_REQUIRED");
  });

  it("accepts a deprecated compact flag while creating a branched product brief", async () => {
    await workspace.installFoundation();
    workspace.commit("install foundation");

    const compact = await runCli(
      workspace.root,
      "feature",
      "add login",
      "--source-brief",
      "Please add login exactly as requested",
      "--risk",
      "low",
      "--workflow",
      "compact",
      "--branch",
      "--json",
    );
    expect(compact.exitCode, compact.stderr).toBe(0);
    expect(JSON.parse(compact.stdout).data.brief).toMatchObject({
      version: 2,
      feature: "001-add-login",
      originalRequest: "Please add login exactly as requested",
    });
    expect(JSON.parse(compact.stdout).data.branchCreated).toBe("feature/001-add-login");
  });

  it("creates the product workflow when optional flags are omitted", async () => {
    await workspace.installFoundation();
    workspace.commit("install foundation");

    const result = await runCli(workspace.root, "feature", "add audit log", "--json");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.brief).toMatchObject({
      version: 2,
      feature: "001-add-audit-log",
    });
  });

  it("maps an uninitialized feature command through the shared state boundary", async () => {
    await rm(`${workspace.root}/.visp`, { recursive: true, force: true });

    const result = await runJson(workspace.root, "feature", "do work");

    expect(result.exitCode).not.toBe(0);
    expect(result.envelope.error?.code).toBe("NOT_INITIALIZED");
  });
});
