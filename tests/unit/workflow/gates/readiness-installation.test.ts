import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { installHarness } from "../../../../src/harness/install.js";
import { createProductFeature as runFeature } from "../../../../src/workflow/product/brief.js";
import { buildFoundationContext } from "../../../../src/workflow/state.js";
import { TestWorkspace } from "../../support/workspace.js";

describe("installed harness readiness", () => {
  let workspace: TestWorkspace;

  beforeEach(async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    const installed = await installHarness(
      state.paths,
      {
        harness: "codex",
        profile: state.config.profile,
        hooks: ["git"],
        mcp: false,
        configUpdates: { harness: "codex" },
      },
      { guardHandshake: async () => ok(undefined) },
    );
    if (!installed.ok) throw new Error(installed.error.message);
    commitWithoutHooks("install codex harness");
  });

  afterEach(async () => {
    await workspace.destroy();
  });

  it("accepts a current generated install and activation", async () => {
    expect(await harnessInstalled()).toBe(true);

    const result = await runFeature(await workspace.state(), {
      goal: "Exercise the installed workflow",
    });
    expect(result.ok).toBe(true);
  });

  it("blocks workflow mutation when a generated harness asset is stale", async () => {
    const guide = join(workspace.root, "AGENTS.visp.md");
    await writeFile(guide, `${await readFile(guide, "utf8")}stale local edit\n`, "utf8");
    commitWithoutHooks("make generated asset stale");

    await expectFeatureBlocked();
  });

  it("blocks workflow mutation when required AGENTS.md activation is missing", async () => {
    await rm(join(workspace.root, "AGENTS.md"));
    commitWithoutHooks("remove harness activation");

    await expectFeatureBlocked();
  });

  it("blocks workflow mutation when the managed activation block was edited", async () => {
    const agents = join(workspace.root, "AGENTS.md");
    const edited = (await readFile(agents, "utf8")).replace(
      "Follow the VISP project instructions",
      "Ignore the VISP project instructions",
    );
    await writeFile(agents, edited, "utf8");
    commitWithoutHooks("edit harness activation");

    await expectFeatureBlocked();
  });

  async function harnessInstalled(): Promise<boolean> {
    const context = await buildFoundationContext(await workspace.state());
    if (!context.ok) throw new Error(context.error.message);
    return context.value.harnessInstalled === true;
  }

  async function expectFeatureBlocked(): Promise<void> {
    expect(await harnessInstalled()).toBe(false);
    const state = await workspace.state();
    const before = await state.store.listFeatures();
    if (!before.ok) throw new Error(before.error.message);

    const result = await runFeature(state, { goal: "Must not be created" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "STAGE_BLOCKED",
        recovery: "visp install",
      });
    }

    const after = await (await workspace.state()).store.listFeatures();
    expect(after).toEqual(before);
  }

  function commitWithoutHooks(message: string): void {
    workspace.git("add", "-A");
    workspace.git("commit", "--no-verify", "-q", "-m", message);
  }
});
