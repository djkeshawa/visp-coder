import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLegacyFeature as runFeature } from "../../support/legacy-feature.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
const acceptanceSource =
  "import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; assert.equal(readFileSync('src/selection.txt', 'utf8').trim(), 'cleared');\n";

beforeEach(async () => {
  workspace = await TestWorkspace.create({
    "src/selection.txt": "stale",
    "acceptance.mjs": acceptanceSource,
  });
  await workspace.installFoundation();
  await workspace.write(
    "visp.yml",
    JSON.stringify({
      harness: "generic",
      workflow: {
        flipCheck: "off",
        acceptanceChecks: [{ command: ["node", "acceptance.mjs"], files: ["acceptance.mjs"] }],
      },
    }),
  );
  workspace.git("add", "-A");
  workspace.git("commit", "--no-verify", "-qm", "acceptance contract");
  const started = await runFeature(await workspace.state(), {
    goal: "Clear selection after archive",
    workflow: "compact",
  });
  if (!started.ok) throw new Error(started.error.message);
});

afterEach(async () => {
  await workspace.destroy();
});

describe("predeclared acceptance checks on historical feature records", () => {
  it("does not allocate a feature when an acceptance file cannot be pinned", async () => {
    const state = await workspace.state();
    const missing = {
      ...state,
      config: {
        ...state.config,
        workflow: {
          ...state.config.workflow,
          acceptanceChecks: [
            {
              command: ["node", "missing.mjs"] as [string, ...string[]],
              files: ["missing.mjs"] as [string, ...string[]],
            },
          ],
        },
      },
    };
    const before = await state.store.listFeatures();
    expect(await runFeature(missing, { goal: "missing acceptance" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await state.store.listFeatures()).toEqual(before);
  });
});
