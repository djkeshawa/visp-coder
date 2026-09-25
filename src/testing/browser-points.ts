/// <reference lib="dom" />
import { measureControl } from "./browser.js";
import { BrowserBehaviorFailure } from "./browser-observations.js";
import type { BrowserSession } from "./browser-session.js";

export interface RelativePoint {
  /** Fractions of the current CSS border box, not canvas backing-store pixels. */
  readonly x: number;
  readonly y: number;
}

export async function actAtPoint(
  session: BrowserSession,
  action: {
    kind: "click" | "tap" | "move";
    selector: string;
    position?: RelativePoint;
    steps?: number;
    durationMs?: number;
  },
): Promise<void> {
  // Hover observes one point; it does not assert that the whole surface is usable.
  const position = action.position ?? (action.kind === "move" ? { x: 0.5, y: 0.5 } : undefined);
  const controlTarget = position ? { selector: action.selector, position } : action.selector;
  const control = await session.page.evaluate(measureControl, controlTarget);
  if (!control.reachable)
    throw new BrowserBehaviorFailure(`${action.selector}: ${control.reasons.join("; ")}`);
  const target = {
    selector: action.selector,
    position: action.position ?? { x: 0.5, y: 0.5 },
    exact: action.position !== undefined,
  };
  const point = await session.page.evaluate(resolveElementPoint, target);
  if (point.error) throw new BrowserBehaviorFailure(`${action.selector}: ${point.error}`);
  if (action.kind !== "tap") {
    await session.page.mouse.move?.(point.x, point.y, {
      steps: action.steps,
      durationMs: action.durationMs,
    });
    const reachable = await session.page.evaluate(measureControl, controlTarget);
    if (!reachable.reachable)
      throw new BrowserBehaviorFailure(`${action.selector}: ${reachable.reasons.join("; ")}`);
    const hit = await session.page.evaluate(measureControl, {
      selector: action.selector,
      point: { x: point.x, y: point.y },
    });
    if (!hit.reachable)
      throw new BrowserBehaviorFailure(
        `${action.selector}: intended click point is no longer reachable: ${hit.reasons.join("; ")}`,
      );
  }
  if (action.kind === "click") await session.page.mouse.click(point.x, point.y);
  if (action.kind === "tap") await session.page.touchscreen.tap(point.x, point.y);
}

/** Serialized into the page; transforms are rejected rather than misreported as exact coordinates. */
export function resolveElementPoint({
  selector,
  position,
  exact,
}: {
  selector: string;
  position: RelativePoint;
  exact: boolean;
}) {
  const elements = document.querySelectorAll(selector);
  const element = elements.length === 1 ? elements[0] : undefined;
  if (!element) return { x: 0, y: 0, error: `Expected one control; found ${elements.length}` };
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      exact &&
      (style.transform !== "none" ||
        style.perspective !== "none" ||
        (style.rotate && style.rotate !== "none") ||
        (style.scale && style.scale !== "none"))
    )
      return { x: 0, y: 0, error: "Element-relative positions require untransformed CSS geometry" };
  }
  const rect = element.getBoundingClientRect();
  const x = rect.left + position.x * rect.width;
  const y = rect.top + position.y * rect.height;
  const hit = document.elementFromPoint(x, y);
  const error =
    x < 0 || x >= innerWidth || y < 0 || y >= innerHeight || !hit || !element.contains(hit)
      ? "Resolved point is outside the viewport or cannot receive pointer input"
      : undefined;
  return {
    x,
    y,
    error,
    borderBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    position,
  };
}
