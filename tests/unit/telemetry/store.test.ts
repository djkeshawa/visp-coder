import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Attempt,
  type CheckEvent,
  readTelemetry,
  summarize,
  type Telemetry,
} from "../../../src/telemetry/store.js";
import { recordLegacyCheck } from "../support/legacy-telemetry.js";
import { TestWorkspace } from "../support/workspace.js";

function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    feature: "001-login",
    verified: true,
    reviewed: true,
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function telemetry(attempts: Attempt[], checks: CheckEvent[] = []): Telemetry {
  return {
    kind: "telemetry",
    createdAt: "2026-01-01T00:00:00.000Z",
    attempts,
    checks,
    usageReceipts: [],
  };
}

describe("summarize", () => {
  it("reports rates as unknown when there is nothing to average", () => {
    const summary = summarize(telemetry([]));
    expect(summary.attempts).toBe(0);
    expect(summary.verifiedRate).toBeUndefined();
    expect(summary.reviewedRate).toBeUndefined();
  });

  it("computes first-pass rates once per task and stage from check events", () => {
    const summary = summarize(
      telemetry(
        [],
        [
          check({ task: "T001", stage: "verify", outcome: "refused", attempt: 1 }),
          check({ task: "T001", stage: "verify", outcome: "passed", attempt: 2 }),
          check({ task: "T002", stage: "verify", outcome: "passed", attempt: 1 }),
          check({ task: "T001", stage: "review", outcome: "passed", attempt: 1 }),
        ],
      ),
    );
    expect(summary.verifiedRate).toBe(0.5);
    expect(summary.reviewedRate).toBe(1);
    expect(summary.workflow.verify).toMatchObject({ checks: 3, tasks: 2, recoveredTasks: 1 });
    expect(summary.workflow.review).toMatchObject({ checks: 1, tasks: 1, recoveredTasks: 0 });
  });

  it("does not present legacy closure claims as measured first-pass rates", () => {
    const summary = summarize(telemetry([attempt(), attempt({ verified: false })]));
    expect(summary.verifiedRate).toBeUndefined();
    expect(summary.reviewedRate).toBeUndefined();
  });

  it("sums the counts an agent reported, and says how many attempts they cover", () => {
    const summary = summarize(
      telemetry([
        attempt({ inputTokens: 100, outputTokens: 50 }),
        attempt({ inputTokens: 200, outputTokens: 25 }),
      ]),
    );
    expect(summary.selfReportedCost.inputTokens).toEqual({ total: 300, fromAttempts: 2 });
    expect(summary.selfReportedCost.outputTokens).toEqual({ total: 75, fromAttempts: 2 });
  });

  it("scopes a total to the attempts that carried a count", () => {
    const summary = summarize(telemetry([attempt({ inputTokens: 100 }), attempt(), attempt()]));
    expect(summary.selfReportedCost.inputTokens).toEqual({ total: 100, fromAttempts: 1 });
    expect(summary.selfReportedCost.attemptsWithoutCost).toBe(2);
  });

  it("leaves a total absent rather than zero when nobody reported one", () => {
    const summary = summarize(telemetry([attempt(), attempt()]));
    expect(summary.selfReportedCost.inputTokens).toEqual({ total: undefined, fromAttempts: 0 });
    expect(summary.selfReportedCost.outputTokens).toEqual({ total: undefined, fromAttempts: 0 });
    expect(summary.selfReportedCost.attemptsWithoutCost).toBe(2);
  });

  it("distinguishes a reported zero from a missing count", () => {
    const withUnknown = summarize(telemetry([attempt()]));
    expect(withUnknown.selfReportedCost.inputTokens.total).toBeUndefined();
    expect(withUnknown.selfReportedCost.attemptsWithoutCost).toBe(1);

    const withZero = summarize(telemetry([attempt({ inputTokens: 0, outputTokens: 0 })]));
    expect(withZero.selfReportedCost.inputTokens).toEqual({ total: 0, fromAttempts: 1 });
    expect(withZero.selfReportedCost.attemptsWithoutCost).toBe(0);
  });

  it("lists each claimed model once, and none when none was claimed", () => {
    const summary = summarize(
      telemetry([
        attempt({ model: "some-model" }),
        attempt({ model: "some-model" }),
        attempt({ model: "other-model" }),
        attempt(),
      ]),
    );
    expect(summary.selfReportedCost.models).toEqual(["some-model", "other-model"]);
    expect(summarize(telemetry([attempt()])).selfReportedCost.models).toEqual([]);
  });

  it("aggregates sourced usage separately from legacy claims", () => {
    const summary = summarize({
      ...telemetry([attempt({ inputTokens: 999 })]),
      usageReceipts: [
        {
          source: "codex",
          runId: "run-1",
          sourceFile: "/tmp/run-1.jsonl",
          sourceFileHash: "a".repeat(64),
          projectRoot: "/tmp/project",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:01:00.000Z",
          importedAt: "2026-01-01T00:02:00.000Z",
          model: "gpt-5.6-luna",
          effort: "max",
          inputTokens: 240,
          cachedInputTokens: 160,
          outputTokens: 30,
          reasoningTokens: 7,
        },
      ],
    });

    expect(summary.measuredUsage).toMatchObject({
      receipts: 1,
      inputTokens: 240,
      cachedInputTokens: 160,
      outputTokens: 30,
      reasoningTokens: 7,
      models: ["gpt-5.6-luna"],
      efforts: ["max"],
    });
    expect(summary.selfReportedCost.inputTokens.total).toBe(999);
  });
});

function check(overrides: Partial<CheckEvent> = {}): CheckEvent {
  return {
    feature: "001-login",
    task: "T001",
    stage: "verify",
    outcome: "passed",
    attempt: 1,
    source: "direct",
    at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("historical check events", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  it("retains concurrent accepted events and assigns unique attempt numbers", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordLegacyCheck(state, {
          feature: "001-login",
          task: "T001",
          stage: "verify",
          outcome: "passed",
          source: "direct",
        }),
      ),
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.checks).toHaveLength(12);
    expect(stored.ok && stored.value.checks.map((event) => event.attempt)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
  });

  it("numbers attempts independently per feature, task, and stage", async () => {
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
      stage: "review",
      outcome: "passed",
      source: "done",
    });
    await recordLegacyCheck(state, {
      feature: "001-login",
      task: "T001",
      stage: "verify",
      outcome: "passed",
      source: "done",
    });

    const stored = await readTelemetry(state);
    if (!stored.ok) throw new Error(stored.error.message);
    expect(
      stored.value.checks.map(({ stage, attempt, source }) => ({ stage, attempt, source })),
    ).toEqual([
      { stage: "verify", attempt: 1, source: "direct" },
      { stage: "review", attempt: 1, source: "done" },
      { stage: "verify", attempt: 2, source: "done" },
    ]);
  });

  it("reads old telemetry with additive collections defaulted", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    await writeFile(
      state.paths.telemetry,
      JSON.stringify({
        kind: "telemetry",
        createdAt: "2026-01-01T00:00:00.000Z",
        attempts: [],
      }),
      "utf8",
    );

    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.checks).toEqual([]);
    expect(stored.ok && stored.value.usageReceipts).toEqual([]);
  });
});

describe("historical attempts", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  /**
   * An earlier build wrote NaN, which lands in the file as `null`. Rejecting it
   * on read would fail the whole file.
   */
  it("reads a null count written by an earlier build as unknown, not as a broken file", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();

    await writeFile(
      state.paths.telemetry,
      JSON.stringify({
        kind: "telemetry",
        createdAt: "2026-01-01T00:00:00.000Z",
        attempts: [
          {
            feature: "001-login",
            verified: true,
            reviewed: true,
            inputTokens: null,
            outputTokens: 20,
            at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const stored = await readTelemetry(state);
    if (!stored.ok) throw new Error(stored.error.message);

    const summary = summarize(stored.value);
    expect(summary.attempts).toBe(1);
    expect(summary.selfReportedCost.inputTokens.total).toBeUndefined();
    expect(summary.selfReportedCost.outputTokens).toEqual({ total: 20, fromAttempts: 1 });
  });
});
