import { describe, expect, it } from "vitest";
import {
  assertFiniteState,
  assertRecovery,
  assertTrajectoryClose,
} from "../../../src/testing/recovery.js";

describe("bounded product recovery", () => {
  it("waits for an asynchronous recovery predicate instead of accepting its promise as truthy", async () => {
    let ready = false;
    await expect(
      assertRecovery({
        label: "async recovery",
        maxSteps: 1,
        sample: () => ready,
        advance: () => {
          ready = true;
        },
        recovered: async (value) => value,
      }),
    ).resolves.toMatchObject({ steps: 1 });
  });
  it("rejects a shot resting on a block forever, then accepts resting on any surface", async () => {
    for (const repaired of [false, true]) {
      let phase = "flying";
      const check = assertRecovery({
        label: "resting bird returns control",
        maxSteps: 60,
        sample: () => phase,
        advance: () => {
          if (repaired) phase = "ready";
        },
        recovered: (value) => value === "ready",
      });
      if (repaired) await expect(check).resolves.toMatchObject({ steps: 1 });
      else
        await expect(check).rejects.toThrow(
          "resting bird returns control: did not recover within 60 steps",
        );
    }
  });

  it("accepts already recovered state without advancing", async () => {
    await expect(
      assertRecovery({
        label: "ready",
        maxSteps: 0,
        sample: () => "ready",
        advance: () => {
          throw new Error("unnecessary step");
        },
        recovered: (value) => value === "ready",
      }),
    ).resolves.toMatchObject({ steps: 0 });
  });

  it("times out a stalled observation and rejects invalid budgets", async () => {
    const options = {
      label: "hung sample",
      maxSteps: 2,
      timeoutMs: 20,
      sample: () => new Promise<never>(() => {}),
      advance: () => {},
      recovered: () => false,
    };
    await expect(assertRecovery(options)).rejects.toThrow("timed out");
    await expect(assertRecovery({ ...options, maxSteps: Infinity })).rejects.toThrow("maxSteps");
  });

  it("rejects non-finite physics and inaccurate predictions", () => {
    expect(() => assertFiniteState({ x: 1, vy: NaN })).toThrow("vy");
    expect(() => assertTrajectoryClose([{ x: 1, y: 26.83 }], [{ x: 1, y: 0 }], 2)).toThrow(
      "sample 0",
    );
    expect(() => assertTrajectoryClose([{ x: 1, y: 1 }], [{ x: 1, y: 0 }], 2)).not.toThrow();
    expect(() => assertTrajectoryClose([], [], 2)).toThrow("non-empty");
    expect(() => assertTrajectoryClose(new Array(2), new Array(2), 2)).toThrow("sample");
    expect(() => assertTrajectoryClose([{ x: 1, y: 0 }], [], 2)).toThrow("equal");
  });
});
