import { afterEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "../../../src/workflow/state.js";
import { recordLegacyAttempt } from "../../unit/support/legacy-telemetry.js";
import { TestProject } from "../support/project.js";

/**
 * Everything else `report` prints, visp watched happen. Token counts it was
 * told. The two must not read alike, and a run nobody told anything about must
 * not print a zero — the bug this covers was `Input tokens: 0` after a whole
 * feature, which looks exactly like a measurement of a very cheap run.
 */

let project: TestProject | undefined;

afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

async function projectWithClosedTask(doneFlags: string[]): Promise<TestProject> {
  const created = await TestProject.create();
  created.run("init", "--harness", "generic");
  const loaded = await loadWorkspace(created.root);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const claimed = (flag: string) => {
    const index = doneFlags.indexOf(flag);
    return index < 0 ? undefined : doneFlags[index + 1];
  };
  const recorded = await recordLegacyAttempt(loaded.value, {
    feature: "001-historical-cost",
    task: "T001",
    verified: true,
    reviewed: true,
    inputTokens: claimed("--input-tokens") ? Number(claimed("--input-tokens")) : undefined,
    outputTokens: claimed("--output-tokens") ? Number(claimed("--output-tokens")) : undefined,
    model: claimed("--model"),
  });
  if (!recorded.ok) throw new Error(recorded.error.message);
  return created;
}

describe("visp report", () => {
  it("says the cost is unknown, not zero, when no agent volunteered a count", async () => {
    project = await projectWithClosedTask([]);

    const result = project.run("report");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Attempts:        1");
    expect(result.stdout).toContain("Input tokens:    unknown");
    expect(result.stdout).toContain("Output tokens:   unknown");
    expect(result.stdout).toContain("Model:           unknown");
    // The whole point: nothing about cost may be printed as a number here.
    expect(result.stdout).not.toMatch(/tokens:\s+\d/i);
    expect(result.stdout).toContain("Self-reported attempts are historical");
  });

  it("labels the figures as claims when an agent did report them", async () => {
    project = await projectWithClosedTask([
      "--input-tokens",
      "1200",
      "--output-tokens",
      "340",
      "--model",
      "test-model",
    ]);

    const result = project.run("report");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Self-reported by the agent");
    expect(result.stdout).toContain("Input tokens:    1200 claimed across 1 of 1 attempts");
    expect(result.stdout).toContain("Output tokens:   340 claimed across 1 of 1 attempts");
    expect(result.stdout).toContain("Model:           test-model");
    expect(result.stdout).toContain("visp never observes token usage");
  });
});
