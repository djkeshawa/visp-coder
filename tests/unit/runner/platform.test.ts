import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerSpec } from "../../../src/runner/contracts.js";
import { runExperiment } from "../../../src/runner/run.js";

afterEach(() => vi.unstubAllGlobals());

describe("runner platform qualification", () => {
  it("refuses Windows host execution before attempting filesystem or host setup", async () => {
    const spec: RunnerSpec = {
      schemaVersion: 1,
      id: "unsupported-platform",
      repository: resolve("nonexistent-fixture-repository"),
      revision: "a".repeat(40),
      task: { feature: "001-platform", task: "T001" },
      prompt: "This request must never reach a host process",
      host: {
        kind: "codex",
        executable: resolve("nonexistent-fixture-host"),
        executableSha256: "b".repeat(64),
        version: "fixture",
        model: "fixture",
      },
      permissions: { mode: "read-only", requireSandbox: false },
      budget: {
        maxDurationMs: 1000,
        maxEstimatedUsd: 1,
        studyMaxEstimatedUsd: 1,
        studyApprovalId: "platform-fixture",
        monetaryEnforcement: "estimated",
        prices: {
          source: "fixture",
          capturedAt: "2026-09-05T00:00:00Z",
          currency: "USD",
          model: "fixture",
          uncachedInputPerMillion: 1,
          cachedInputPerMillion: 1,
          cacheWriteInputPerMillion: 1,
          outputPerMillion: 1,
        },
      },
      harness: { mode: "disabled", files: [], requiredTools: [], requiredHooks: [] },
      assignment: {
        study: "qualification",
        scenario: "platform",
        repositoryGroup: "fixture",
        arm: "economical-baseline",
        split: "pilot",
        repetition: 0,
        order: 0,
      },
    };
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, property, receiver) =>
          property === "platform" ? "win32" : Reflect.get(target, property, receiver),
      }),
    );
    await expect(
      runExperiment(spec, { outputRoot: resolve("nonexistent-fixture-output") }),
    ).rejects.toThrow("Windows execution is not yet qualified");
  });
});
