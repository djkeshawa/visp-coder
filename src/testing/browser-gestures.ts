import type { BrowserOperation, PageSend } from "./browser-session.js";

export const POINTER_TRAVEL_DEFAULTS = { steps: 12, durationMs: 100 } as const;
export const DRAG_DEFAULTS = {
  input: "pointer",
  cancel: false,
  steps: 12,
  durationMs: 300,
} as const;

export interface PointerTravel {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly steps?: number;
  readonly durationMs?: number;
}

/** Ordinary unpressed movement exposes hover and aim changes between controls. */
export async function dispatchPointerTravel(send: PageSend, travel: PointerTravel) {
  const {
    from,
    to,
    steps = POINTER_TRAVEL_DEFAULTS.steps,
    durationMs = POINTER_TRAVEL_DEFAULTS.durationMs,
  } = travel;
  if (
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 60 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > 2000 ||
    ![from.x, from.y, to.x, to.y].every(Number.isFinite)
  )
    throw new Error("Invalid bounded pointer movement");
  const path: { x: number; y: number }[] = [];
  for (let step = 1; step <= steps; step++) {
    const point = {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    };
    if (durationMs) await new Promise((resolve) => setTimeout(resolve, durationMs / steps));
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 0 });
    path.push(point);
  }
  return { from, to, path, durationMs };
}

export interface DragGesture {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly input: "pointer" | "touch";
  readonly cancel?: boolean;
  readonly steps: number;
  readonly durationMs: number;
}

/** Native browser input, with release on failure; no fabricated DOM events or success booleans. */
export async function dispatchDrag(
  send: PageSend,
  record: (kind: BrowserOperation["kind"], description: string) => void,
  gesture: DragGesture,
  intermediate?: () => Promise<void>,
): Promise<void> {
  const { from, to, steps, durationMs, input } = gesture;
  validateDragGesture(gesture);
  const touch = input === "touch";
  let point = from;
  try {
    if (touch)
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ ...from, id: 0 }],
      });
    else {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...from,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
    }
    record(input, `Begin ${input} drag ${from.x},${from.y} to ${to.x},${to.y}`);
    for (let step = 1; step <= steps; step++) {
      point = {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      };
      if (durationMs) await new Promise((resolve) => setTimeout(resolve, durationMs / steps));
      if (touch)
        await send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ ...point, id: 0 }],
        });
      else
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          button: "left",
          buttons: 1,
        });
      if (step === Math.floor(steps / 2)) await intermediate?.();
    }
  } finally {
    if (touch)
      await send("Input.dispatchTouchEvent", {
        type: gesture.cancel ? "touchCancel" : "touchEnd",
        touchPoints: [],
      });
    else
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...point,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
  }
  record(input, `${gesture.cancel ? "Cancel" : "Finish"} ${input} drag at ${to.x},${to.y}`);
}

function validateDragGesture(gesture: DragGesture): void {
  const { from, to, steps, durationMs } = gesture;
  if (
    !["pointer", "touch"].includes(gesture.input) ||
    (gesture.cancel === true && gesture.input !== "touch") ||
    !Number.isInteger(steps) ||
    steps < 2 ||
    steps > 60 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > 2000 ||
    ![from.x, from.y, to.x, to.y].every(Number.isFinite)
  )
    throw new Error("Invalid bounded drag gesture");
}
