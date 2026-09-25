import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallPreview } from "../../../src/harness/install.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";
import { runCli, runJson } from "./support/cli.js";

let workspace: TestWorkspace;
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace.destroy();
});

describe("setup readiness CLI", () => {
  it("does not ask active product work to commit a new feature baseline", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    const doctor = await runJson<{ featureReadiness: { requirement: string }[] }>(
      workspace.root,
      "doctor",
    );
    expect(doctor.envelope.data?.featureReadiness).toEqual([]);
    const text = await runCli(workspace.root, "doctor");
    expect(text.stdout).not.toContain("Before starting a feature:");
    expect(text.stdout).not.toContain("commit the project baseline");
  });

  it("still reports missing enforcement while a product feature is active", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    await rm(join(workspace.root, ".git/hooks/pre-commit"));
    const doctor = await runJson<{ featureReadiness: { requirement: string }[] }>(
      workspace.root,
      "doctor",
    );
    expect(doctor.envelope.data?.featureReadiness.map((blocker) => blocker.requirement)).toEqual([
      "enforcement",
    ]);
    const text = await runCli(workspace.root, "doctor");
    expect(text.stdout).toContain("Before continuing feature work:");
    expect(text.stdout).not.toContain("clean-baseline");
  });
  it("shows an unchanged installation but still refuses feature authorization without local hooks", async () => {
    const installed = await runCli(workspace.root, "install", "--no-hooks", "--no-mcp");
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.stdout).toContain("cannot authorize coding");
    workspace.commit("reviewed assets-only setup");
    const preview = await runCli(workspace.root, "install", "--dry-run", "--no-hooks", "--no-mcp");
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Installed files are current");
    const feature = await runJson(workspace.root, "feature", "Create a game");
    expect(feature.envelope.error).toMatchObject({
      code: "STAGE_BLOCKED",
      details: { mayEdit: false, blockers: [{ requirement: "enforcement" }] },
    });
  });

  it("previews planned paths and required local enforcement in text and JSON without mutation", async () => {
    const before = await snapshot(workspace.root);
    const text = await runCli(workspace.root, "install", "--dry-run", "--no-hooks", "--no-mcp");
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("no files changed");
    expect(text.stdout).toContain("write  AGENTS.visp.md");
    expect(text.stdout).toContain("cannot authorize coding");
    const json = await runJson<InstallPreview>(
      workspace.root,
      "install",
      "--dry-run",
      "--no-hooks",
      "--no-mcp",
    );
    expect(json.envelope.data).toMatchObject({ dryRun: true, localEnforcement: "omitted" });
    expect(await snapshot(workspace.root)).toEqual(before);
  });

  it("exposes all known feature blockers through doctor without recovering pending transactions", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const path = `.visp/state/transactions/${id}.json`;
    await workspace.write(
      path,
      JSON.stringify({
        version: 1,
        id,
        label: "interrupted setup",
        createdAt: "2026-01-01T00:00:00.000Z",
        state: "prepared",
        entries: [{ kind: "remove", path: "absent.txt", before: { existed: false } }],
      }),
    );
    await workspace.write("unrelated.txt", "retain pending source\n");
    const before = await snapshot(workspace.root);
    const doctor = await runJson<{ featureReadiness: { requirement: string }[] }>(
      workspace.root,
      "doctor",
    );
    expect(doctor.envelope.data?.featureReadiness.map((blocker) => blocker.requirement)).toEqual([
      "harness",
      "enforcement",
      "clean-baseline",
    ]);
    const preview = await runJson(workspace.root, "install", "--dry-run", "--no-hooks", "--no-mcp");
    expect(preview.envelope.error).toMatchObject({
      code: "STAGE_BLOCKED",
      details: { pending: [id] },
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
