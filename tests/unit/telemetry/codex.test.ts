import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importCodexUsage, parseCodexRollout } from "../../../src/telemetry/codex.js";
import { readTelemetry } from "../../../src/telemetry/store.js";
import { TestWorkspace } from "../support/workspace.js";

describe("importCodexUsage", () => {
  let workspace: TestWorkspace | undefined;

  afterEach(async () => {
    await workspace?.destroy();
    workspace = undefined;
  });

  it.each([
    [
      "reversed duration",
      (rows: FixtureRow[]) => {
        fixturePayload(rows, 0).timestamp = "2026-01-01T00:01:00.000Z";
      },
    ],
    [
      "cached input exceeding input",
      (rows: FixtureRow[]) => {
        fixtureUsage(rows).cached_input_tokens = 241;
      },
    ],
    [
      "reasoning exceeding output",
      (rows: FixtureRow[]) => {
        fixtureUsage(rows).reasoning_output_tokens = 31;
      },
    ],
    [
      "decreasing cumulative counts",
      (rows: FixtureRow[]) => {
        fixtureUsage(rows).input_tokens = 90;
        fixtureUsage(rows).cached_input_tokens = 60;
      },
    ],
    [
      "malformed later snapshot",
      (rows: FixtureRow[]) => {
        fixtureUsage(rows).input_tokens = -1;
      },
    ],
  ])("refuses %s", async (_label, alter) => {
    const rows = (await validRollout("/tmp", "run-1")).split("\n").map((line) => JSON.parse(line));
    alter(rows);
    expect(parseCodexRollout(rows.map((row) => JSON.stringify(row)).join("\n")).ok).toBe(false);
  });

  it("attributes cumulative deltas to their model instead of assigning the final model every token", async () => {
    const rows = (await validRollout("/tmp", "run-1")).split("\n").map((line) => JSON.parse(line));
    rows.splice(3, 0, {
      timestamp: "2026-01-01T00:00:02.500Z",
      type: "turn_context",
      payload: { cwd: "/tmp", model: "second-model", effort: "high" },
    });
    const result = parseCodexRollout(rows.map((row) => JSON.stringify(row)).join("\n"));
    expect(result.ok && result.value.model).toBeUndefined();
    expect(result.ok && result.value.segments).toMatchObject([
      { model: "gpt-5.6-luna", inputTokens: 100, outputTokens: 10 },
      { model: "second-model", inputTokens: 140, outputTokens: 20 },
    ]);
  });

  it("imports the final cumulative token snapshot with source provenance", async () => {
    workspace = await TestWorkspace.create();
    const file = await rollout(workspace.root, { runId: "run-1" });
    const state = await workspace.state();

    const imported = await importCodexUsage(state, file);
    expect(imported.ok && imported.value.imported).toBe(true);
    expect(imported.ok && imported.value.receipt).toMatchObject({
      source: "codex",
      runId: "run-1",
      projectRoot: workspace.root,
      model: "gpt-5.6-luna",
      effort: "max",
      inputTokens: 240,
      cachedInputTokens: 160,
      outputTokens: 30,
      reasoningTokens: 7,
    });
    expect(imported.ok && imported.value.receipt.sourceFileHash).toMatch(/^[a-f0-9]{64}$/);

    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.usageReceipts).toHaveLength(1);
  });

  it("is idempotent for the same source, run, and file hash", async () => {
    workspace = await TestWorkspace.create();
    const file = await rollout(workspace.root, { runId: "run-1" });
    const state = await workspace.state();

    const first = await importCodexUsage(state, file);
    const second = await importCodexUsage(state, file);
    expect(first.ok && first.value.imported).toBe(true);
    expect(second.ok && second.value.imported).toBe(false);

    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.usageReceipts).toHaveLength(1);
  });

  it("refuses a changed rollout that claims an already imported run", async () => {
    workspace = await TestWorkspace.create();
    const file = await rollout(workspace.root, { runId: "run-1" });
    const state = await workspace.state();
    await importCodexUsage(state, file);
    await writeFile(
      join(workspace.root, file),
      `${await validRollout(workspace.root, "run-1")}\n`,
      "utf8",
    );

    const conflict = await importCodexUsage(state, file);
    expect(conflict.ok).toBe(false);
    expect(!conflict.ok && conflict.error.message).toContain("already imported");
  });

  it("refuses a rollout whose canonical cwd is another project", async () => {
    workspace = await TestWorkspace.create();
    const file = await rollout(tmpdir(), { runId: "run-wrong", directory: workspace.root });

    const result = await importCodexUsage(await workspace.state(), file);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("does not match this project");
  });
});

async function rollout(
  cwd: string,
  options: { runId: string; directory?: string },
): Promise<string> {
  const directory = options.directory ?? cwd;
  const file = `${options.runId}.jsonl`;
  await writeFile(join(directory, file), await validRollout(cwd, options.runId), "utf8");
  return file;
}

async function validRollout(cwd: string, runId: string): Promise<string> {
  const rows = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      type: "session_meta",
      payload: { id: runId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    },
    {
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "turn_context",
      payload: { cwd, model: "gpt-5.6-luna", effort: "max" },
    },
    {
      timestamp: "2026-01-01T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 10,
            reasoning_output_tokens: 2,
          },
        },
      },
    },
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 240,
            cached_input_tokens: 160,
            output_tokens: 30,
            reasoning_output_tokens: 7,
          },
        },
      },
    },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

interface FixtureRow {
  readonly payload: Record<string, unknown>;
}
function fixturePayload(rows: FixtureRow[], index: number): Record<string, unknown> {
  const row = rows[index];
  if (!row) throw new Error("missing fixture row");
  return row.payload;
}
function fixtureUsage(rows: FixtureRow[]): Record<string, number> {
  const info = fixturePayload(rows, 3).info as { total_token_usage: Record<string, number> };
  return info.total_token_usage;
}
