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

/**
 * Serialized into the page. Rotation, skew and perspective are rejected rather than misreported as
 * exact coordinates; pure scale and translate stay allowed because the border box is measured after
 * the transform (fit-to-window canvases scale their box).
 */
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
  if (!element)
    return {
      x: 0,
      y: 0,
      error: `Expected one control; found ${elements.length}`,
      unsupportedGeometry: false,
    };
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (
      exact &&
      (style.perspective !== "none" ||
        (style.rotate && style.rotate !== "none") ||
        (style.offsetPath && style.offsetPath !== "none") ||
        !isScaleAndTranslate(style.transform) ||
        !isPositiveScale(style.scale))
    )
      return {
        x: 0,
        y: 0,
        error:
          "Element-relative positions cannot follow rotated, skewed or perspective CSS geometry (scale and translate are fine)",
        unsupportedGeometry: true,
      };
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
    unsupportedGeometry: false,
    borderBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    position,
  };

  // Keep browser-side helpers inside the serialized function.
  function isScaleAndTranslate(transform: string): boolean {
    if (!transform || transform === "none") return true;
    const match = /^matrix\(([^)]*)\)$/.exec(transform);
    if (!match) return false; // matrix3d and anything unparsed
    const [a, b, c, d] = (match[1] ?? "").split(",").map(Number);
    if (![a, b, c, d].every(Number.isFinite)) return false;
    // Zero off-diagonals (relative to the scale terms) exclude rotation and skew; positive scales
    // exclude flips and a 180 degree turn.
    const tolerance = 1e-4 * Math.max(Math.abs(a as number), Math.abs(d as number));
    return (
      Math.abs(b as number) <= tolerance &&
      Math.abs(c as number) <= tolerance &&
      (a as number) > 0 &&
      (d as number) > 0
    );
  }

  function isPositiveScale(scale: string | undefined): boolean {
    if (!scale || scale === "none") return true;
    return scale
      .split(/\s+/)
      .slice(0, 2)
      .every((part) => Number.parseFloat(part) > 0);
  }
}
