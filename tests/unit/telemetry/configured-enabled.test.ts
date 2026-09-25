import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { readTelemetry, recordUsageReceipt } from "../../../src/telemetry/store.js";
import { recordLegacyAttempt, recordLegacyCheck } from "../support/legacy-telemetry.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => workspace?.destroy());
it("stops new telemetry while disabled, preserves readable history and resumes without resetting counters", async () => {
  workspace = await TestWorkspace.create();
  const event = {
    feature: "001-test",
    task: "T001",
    stage: "verify",
    outcome: "passed",
    source: "direct",
  } as const;
  expect((await recordLegacyCheck(await workspace.state(), event)).ok).toBe(true);
  const before = await readTelemetry(await workspace.state());
  const state = await workspace.state();
  const config = parse(await readFile(state.paths.config, "utf8"));
  config.telemetry = { enabled: false };
  await workspace.write("visp.yml", stringify(config));
  const disabled = await workspace.state();
  expect((await recordLegacyCheck(disabled, event)).ok).toBe(true);
  expect(
    (await recordLegacyAttempt(disabled, { feature: "001-test", verified: true, reviewed: true }))
      .ok,
  ).toBe(true);
  expect(
    await recordUsageReceipt(disabled, {
      source: "codex",
      runId: "disabled-run",
      sourceFile: "/tmp/disabled.jsonl",
      sourceFileHash: "a".repeat(64),
      projectRoot: workspace.root,
      importedAt: new Date().toISOString(),
      startedAt: "2026-09-22T00:00:00.000Z",
      endedAt: "2026-09-22T00:00:01.000Z",
      cachedInputTokens: 0,
      reasoningTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
    }),
  ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  expect(await readTelemetry(disabled)).toEqual(before);
  config.telemetry.enabled = true;
  await workspace.write("visp.yml", stringify(config));
  expect((await recordLegacyCheck(await workspace.state(), event)).ok).toBe(true);
  const after = await readTelemetry(await workspace.state());
  expect(after.ok && after.value.checks.map((check) => check.attempt)).toEqual([1, 2]);
});
