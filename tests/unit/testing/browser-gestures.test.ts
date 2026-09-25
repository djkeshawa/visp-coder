import { expect, it, vi } from "vitest";
import { dispatchDrag, dispatchPointerTravel } from "../../../src/testing/browser-gestures.js";
import type { PageSend } from "../../../src/testing/browser-session.js";

const gesture = {
  from: { x: 10, y: 20 },
  to: { x: 90, y: 20 },
  input: "pointer" as const,
  steps: 4,
  durationMs: 0,
};
it.each(["pointer", "touch"] as const)(
  "releases %s input when intermediate capture fails and never records completion",
  async (input) => {
    const send = vi.fn(async () => ({})),
      record = vi.fn();
    await expect(
      dispatchDrag(send, record, { ...gesture, input }, async () => {
        throw new Error("capture failed");
      }),
    ).rejects.toThrow(/capture failed/);
    expect(send.mock.calls.at(-1)).toEqual(
      input === "touch"
        ? ["Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }]
        : [
            "Input.dispatchMouseEvent",
            { type: "mouseReleased", x: 50, y: 20, button: "left", buttons: 0, clickCount: 1 },
          ],
    );
    expect(record).toHaveBeenCalledTimes(1);
  },
);
it("rejects unbounded or invalid gestures before browser input", async () => {
  const send = vi.fn();
  for (const bad of [
    { ...gesture, steps: 1 },
    { ...gesture, steps: 61 },
    { ...gesture, durationMs: 2001 },
    { ...gesture, durationMs: -1 },
    { ...gesture, from: { x: NaN, y: 20 } },
    { ...gesture, input: "fake" as "pointer" },
  ])
    await expect(dispatchDrag(send, vi.fn(), bad)).rejects.toThrow(/Invalid/);
  expect(send).not.toHaveBeenCalled();
});
it("records a native completed gesture without requiring an intermediate image", async () => {
  const send = vi.fn(async () => ({})),
    record = vi.fn();
  await dispatchDrag(send, record, gesture);
  expect(record).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 90,
    y: 20,
    button: "left",
    buttons: 1,
  });
});

it("records bounded ordinary pointer travel without pressed buttons", async () => {
  const send = vi.fn<PageSend>(async () => ({}));
  const result = await dispatchPointerTravel(send, {
    from: gesture.from,
    to: gesture.to,
    steps: 4,
    durationMs: 0,
  });
  expect(result.path).toEqual([
    { x: 30, y: 20 },
    { x: 50, y: 20 },
    { x: 70, y: 20 },
    { x: 90, y: 20 },
  ]);
  expect(
    send.mock.calls.every((call) => call[1]?.buttons === 0 && call[1]?.type === "mouseMoved"),
  ).toBe(true);
  expect(
    (await dispatchPointerTravel(send, { from: gesture.from, to: gesture.to })).path,
  ).toHaveLength(12);
});

it("rejects unbounded pointer interpolation before dispatch", async () => {
  const send = vi.fn();
  for (const options of [
    { steps: 0 },
    { steps: 61 },
    { steps: 1.5 },
    { durationMs: -1 },
    { durationMs: 2001 },
    { durationMs: NaN },
    { to: { x: Infinity, y: 1 } },
  ])
    await expect(dispatchPointerTravel(send, { ...gesture, ...options })).rejects.toThrow(
      /Invalid bounded pointer/,
    );
  expect(send).not.toHaveBeenCalled();
});
