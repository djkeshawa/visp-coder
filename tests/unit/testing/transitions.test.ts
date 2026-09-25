import { describe, expect, it } from "vitest";
import { assertBehaviorSensitive, assertTransitions } from "../../../src/testing/transitions.js";

describe("product transition contracts", () => {
  it("rejects an intermediate defect even when both endpoints are correct", async () => {
    let attached = true;
    await expect(
      assertTransitions({
        label: "drag attachment",
        sample: () => ({ attached }),
        steps: [
          {
            name: "pull",
            act: async () => {
              attached = false;
              await new Promise((resolve) => setTimeout(resolve, 25));
              attached = true;
            },
            during: (_before, current) => current.attached,
            sampleIntervalMs: 1,
            verify: (before, after) => before.attached && after.attached,
          },
        ],
      }),
    ).rejects.toThrow("during pull");
  });

  it("returns intermediate observations for a held interaction", async () => {
    let position = 0;
    const result = await assertTransitions({
      label: "drag",
      sample: () => ({ position }),
      steps: [
        {
          name: "move",
          act: async () => {
            position = 1;
            await new Promise((resolve) => setTimeout(resolve, 25));
            position = 2;
          },
          during: (_before, current) => current.position === 1,
          sampleIntervalMs: 1,
          verify: (_before, after) => after.position === 2,
        },
      ],
    });
    expect(result[0]?.during.length).toBeGreaterThan(0);
    expect(result[0]?.during.every((sample) => sample.position === 1)).toBe(true);
  });

  it("does not credit an instantaneous action with intermediate coverage", async () => {
    await expect(
      assertTransitions({
        label: "instant",
        sample: () => 1,
        steps: [{ name: "instant", act: () => {}, during: () => true, verify: () => true }],
      }),
    ).rejects.toThrow("intermediate samples");
  });

  it("rejects invalid sampling options before performing an action", async () => {
    let acted = false;
    await expect(
      assertTransitions({
        label: "invalid",
        sample: () => 1,
        steps: [
          {
            name: "bad",
            act: () => {
              acted = true;
            },
            sampleIntervalMs: 0,
            during: () => true,
            verify: () => true,
          },
        ],
      }),
    ).rejects.toThrow("sampleIntervalMs");
    expect(acted).toBe(false);
  });
  it("detects cancellation consuming a resource and verifies a repaired retry sequence", async () => {
    for (const repaired of [false, true]) {
      let state = { phase: "ready", remaining: 3 };
      const check = assertTransitions({
        label: "cancel and retry",
        sample: () => ({ ...state }),
        steps: [
          {
            name: "cancel",
            act: () => {
              state = { phase: "ready", remaining: repaired ? 3 : 2 };
            },
            verify: (before, after) =>
              before.remaining === after.remaining && after.phase === "ready",
          },
          {
            name: "retry",
            act: () => {
              state = { phase: "running", remaining: state.remaining - 1 };
            },
            verify: (before, after) =>
              after.remaining === before.remaining - 1 && after.phase === "running",
          },
        ],
      });
      if (repaired) await expect(check).resolves.toHaveLength(2);
      else await expect(check).rejects.toThrow("cancel");
    }
  });

  it("rejects empty sequences, nonboolean checks, and hung actions", async () => {
    await expect(assertTransitions({ label: "empty", sample: () => 1, steps: [] })).rejects.toThrow(
      "non-empty",
    );
    await expect(
      assertTransitions({
        label: "hung",
        sample: () => 1,
        timeoutMs: 10,
        steps: [{ name: "wait", act: () => new Promise(() => {}), verify: () => true }],
      }),
    ).rejects.toThrow("timed out");
    await expect(
      assertTransitions({
        label: "invalid",
        sample: () => 1,
        steps: [{ name: "bad predicate", act: () => {}, verify: () => 1 as unknown as boolean }],
      }),
    ).rejects.toThrow("boolean");
  });

  it("rejects a detached probe that passes for both working and broken production behavior", async () => {
    await expect(
      assertBehaviorSensitive({
        label: "production gravity",
        baseline: () => true,
        changed: () => true,
      }),
    ).rejects.toThrow("did not detect");
    await expect(
      assertBehaviorSensitive({
        label: "production gravity",
        baseline: () => true,
        changed: () => false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertBehaviorSensitive({
        label: "broken baseline",
        baseline: () => false,
        changed: () => false,
      }),
    ).rejects.toThrow("baseline");
    await expect(
      assertBehaviorSensitive({
        label: "crashed setup",
        baseline: () => true,
        changed: () => {
          throw Error("missing file");
        },
      }),
    ).rejects.toThrow("missing file");
  });
});
