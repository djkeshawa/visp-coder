import { readdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFileTransaction, withStateMutation } from "../../../src/core/file-transaction.js";
import { ok } from "../../../src/core/result.js";
import { rebuildTelemetryProjection } from "../../../src/telemetry/journal.js";
import { readTelemetry } from "../../../src/telemetry/store.js";
import { recordLegacyCheck } from "../support/legacy-telemetry.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
  workspace = undefined;
});
const event = {
  feature: "001-login",
  task: "T001",
  stage: "verify",
  outcome: "passed",
  source: "direct",
} as const;

describe("immutable telemetry journal", () => {
  it("reads each prior event once when deriving the next attempt under the lock", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    for (let index = 0; index < 5; index += 1)
      expect((await recordLegacyCheck(state, event)).ok).toBe(true);
    const reads = vi.spyOn(state.files, "readJson");
    expect((await recordLegacyCheck(state, event)).ok).toBe(true);
    const eventReads = reads.mock.calls.filter(([path]) => /\.events\/\d{12}-/.test(path));
    expect(eventReads).toHaveLength(5);
    expect(new Set(eventReads.map(([path]) => path)).size).toBe(5);
    const result = await readTelemetry(state);
    expect(result.ok && result.value.checks.map((check) => check.attempt)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });
  it("does not report success from a prepared transaction before recovery", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    expect((await recordLegacyCheck(state, event)).ok).toBe(true);
    const interrupted = await applyFileTransaction(
      state.paths.root,
      "interrupted-report",
      [{ kind: "write", path: state.paths.telemetry, content: "partial projection" }],
      {
        leavePreparedOnError: true,
        afterMutation: () => {
          throw new Error("interrupted");
        },
      },
    );
    expect(interrupted.ok).toBe(false);
    expect((await readTelemetry(state)).ok).toBe(false);
    expect((await rebuildTelemetryProjection(state)).ok).toBe(true);
    const recovered = await readTelemetry(state);
    expect(recovered.ok && recovered.value.checks).toHaveLength(1);
  });
  it("retains nested concurrent mutations under a single outer mutation", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    expect((await recordLegacyCheck(state, event)).ok).toBe(true);
    const results = await withStateMutation(state.paths.root, async () =>
      ok(await Promise.all(Array.from({ length: 4 }, () => recordLegacyCheck(state, event)))),
    );
    expect(results.ok && results.value.filter((result) => !result.ok)).toEqual([]);
    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.checks.map((check) => check.attempt)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(["baseline.json", "head.json", "event"])(
    "refuses an incomplete journal missing %s",
    async (missing) => {
      workspace = await TestWorkspace.create();
      const state = await workspace.state();
      expect((await recordLegacyCheck(state, event)).ok).toBe(true);
      const directory = `${state.paths.telemetry}.events`;
      const file =
        missing === "event"
          ? (await readdir(directory)).find((name) => name.startsWith("000"))
          : missing;
      await rm(`${directory}/${file}`);
      expect((await readTelemetry(state)).ok).toBe(false);
      expect((await recordLegacyCheck(state, event)).ok).toBe(false);
      expect((await rebuildTelemetryProjection(state)).ok).toBe(false);
    },
  );

  it("replays canonical events and explicitly rebuilds a broken projection", async () => {
    workspace = await TestWorkspace.create();
    const state = await workspace.state();
    expect((await recordLegacyCheck(state, event)).ok).toBe(true);
    await writeFile(state.paths.telemetry, "broken projection");
    const stored = await readTelemetry(state);
    expect(stored.ok && stored.value.checks).toHaveLength(1);
    expect((await rebuildTelemetryProjection(state)).ok).toBe(true);
    expect(await readTelemetry(state)).toEqual(stored);
  });
});
