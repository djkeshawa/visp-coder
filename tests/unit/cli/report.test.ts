import { afterEach, describe, expect, it } from "vitest";
import { recordUsageReceipt } from "../../../src/telemetry/store.js";
import { recordLegacyAttempt, recordLegacyCheck } from "../support/legacy-telemetry.js";
import { TestWorkspace } from "../support/workspace.js";
import { registeredCommands, runCli, runJson } from "./support/cli.js";

describe("report", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  it("registers usage import and none of the retired stage-workflow commands", async () => {
    const commands = await registeredCommands();
    expect(commands).toContain("usage");
    for (const retired of [
      "research",
      "spec",
      "plan",
      "tasks",
      "context",
      "gate",
      "observe",
      "save",
      "checkpoint",
      "probe",
      "evidence",
    ])
      expect(commands).not.toContain(retired);
  });

  it("separates measured checks, sourced usage, and legacy claims", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    await recordLegacyCheck(state, {
      feature: "001-login",
      task: "T001",
      stage: "verify",
      outcome: "refused",
      source: "direct",
    });
    await recordLegacyCheck(state, {
      feature: "001-login",
      task: "T001",
      stage: "verify",
      outcome: "passed",
      source: "done",
    });
    await recordUsageReceipt(state, {
      source: "codex",
      runId: "run-1",
      sourceFile: "/tmp/run-1.jsonl",
      sourceFileHash: "a".repeat(64),
      projectRoot: workspace.root,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      importedAt: "2026-01-01T00:02:00.000Z",
      model: "gpt-5.6-luna",
      effort: "max",
      inputTokens: 240,
      cachedInputTokens: 160,
      outputTokens: 30,
      reasoningTokens: 7,
    });
    await recordLegacyAttempt(state, {
      feature: "001-login",
      task: "T001",
      verified: true,
      reviewed: true,
      inputTokens: 999,
    });

    const { stdout } = await runCli(workspace.root, "report");
    expect(stdout).toContain("Workflow checks measured by visp");
    expect(stdout).toContain("Product feedback loop");
    expect(stdout).toContain("Graph actions:");
    expect(stdout).toContain("passing execution does not establish goal fidelity");
    expect(stdout).toContain("2 checks across 1 task; 0% first pass; 1 recovered");
    expect(stdout).toContain("Measured usage imported from hosts");
    expect(stdout).toContain("Cached input:    160");
    expect(stdout).toContain("Legacy self-reported claims");
    expect(stdout).toContain("999 claimed");
  });

  it("exposes the three provenance classes separately in JSON", async () => {
    workspace = await TestWorkspace.create();
    const { envelope } = await runJson<{
      workflow: unknown;
      measuredUsage: unknown;
      selfReportedCost: unknown;
      capabilities: { product: { features: number } };
    }>(workspace.root, "report");

    expect(envelope.data).toHaveProperty("workflow");
    expect(envelope.data).toHaveProperty("measuredUsage");
    expect(envelope.data).toHaveProperty("selfReportedCost");
    expect(envelope.data?.capabilities.product.features).toBe(0);
  });

  it("ignores screenshots stored at the feature evidence root", async () => {
    workspace = await TestWorkspace.create();
    await workspace.withFeature("001-login");
    await workspace.write(
      ".visp/features/001-login/evidence/active-mobile.png",
      "advisory image bytes",
    );

    const result = await runJson<{ capabilities: unknown }>(workspace.root, "report");

    expect(result.exitCode).toBe(0);
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toHaveProperty("capabilities");
  });
});
