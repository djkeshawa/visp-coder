import { describe, expect, it, vi } from "vitest";
import { assertCheckpoint } from "../../../src/testing/evidence.js";
import { assertBehaviorSensitive } from "../../../src/testing/transitions.js";

const evidence = { criterion: "AC001", id: "result", surface: "data" as const };
describe("executed evidence receipts", () => {
  it("emits a checkpoint only after observing and asserting its output", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        assertCheckpoint({ ...evidence, sample: () => 3, verify: (actual) => actual === 4 }),
      ).rejects.toThrow("result");
      expect(log).not.toHaveBeenCalled();
      await expect(
        assertCheckpoint({ ...evidence, sample: () => 4, verify: (actual) => actual === 4 }),
      ).resolves.toBe(4);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"samples":1'));
    } finally {
      log.mockRestore();
    }
  });
  it("runs the same expectation against both subjects and cleans them up", async () => {
    const seen: number[] = [],
      disposed: number[] = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await assertBehaviorSensitive({
        label: "disabled output",
        evidence,
        baseline: () => ({ value: 4 }),
        changed: () => ({ value: 0 }),
        verify: (subject) => {
          seen.push(subject.value);
          return subject.value === 4;
        },
        dispose: (subject) => {
          disposed.push(subject.value);
        },
      });
      expect(seen).toEqual([4, 0]);
      expect(disposed).toEqual([4, 0]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"kind":"negative-control"'));
    } finally {
      log.mockRestore();
    }
  });
});
