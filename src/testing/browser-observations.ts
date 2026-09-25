/// <reference lib="dom" />
import type { BrowserSession } from "./browser-session.js";

export interface ObservationCondition {
  readonly selector: string;
  readonly text?: string;
  readonly attribute?: { name: string; value: string | null };
  /** Hidden means one existing, non-rendered element; absent means no matching element. */
  readonly visibility?: "visible" | "hidden" | "absent";
  readonly enabled?: boolean;
  readonly timeoutMs?: number;
}

export class BrowserBehaviorFailure extends Error {
  constructor(
    message: string,
    readonly status: "failed" | "timed-out" = "failed",
    readonly operationId?: string,
  ) {
    super(message);
  }
}

/** DOM observation deliberately does not require an enabled or reachable control. */
export function observeElement(condition: ObservationCondition) {
  const matches = document.querySelectorAll(condition.selector);
  const element = matches.length === 1 ? matches[0] : undefined;
  const rect = element?.getBoundingClientRect();
  const text = element?.textContent ?? null;
  const attribute = condition.attribute
    ? (element?.getAttribute(condition.attribute.name) ?? null)
    : null;
  return {
    count: matches.length,
    visible: isVisible(element),
    inViewport:
      !!rect &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth,
    enabled: element
      ? !element.matches(":disabled, [aria-disabled='true']") && !element.closest("[inert]")
      : null,
    text: text?.slice(0, 2048) ?? null,
    attribute: attribute?.slice(0, 2048) ?? null,
    textTruncated: (text?.length ?? 0) > 2048,
    attributeTruncated: (attribute?.length ?? 0) > 2048,
    truncated: (text?.length ?? 0) > 2048 || (attribute?.length ?? 0) > 2048,
  };

  function isVisible(target?: Element): boolean {
    const box = target?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.height <= 0) return false;
    for (let ancestor = target; ancestor; ancestor = ancestor.parentElement ?? undefined) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
        return false;
    }
    return true;
  }
}

export function matchesObservation(
  condition: ObservationCondition,
  actual: ReturnType<typeof observeElement>,
): boolean {
  if (condition.visibility === "absent") return actual.count === 0;
  if (actual.count !== 1) return false;
  const visibility =
    condition.visibility ??
    (condition.enabled === undefined && condition.text === undefined && !condition.attribute
      ? "visible"
      : undefined);
  return (
    (visibility === undefined || actual.visible === (visibility === "visible")) &&
    (condition.enabled === undefined || actual.enabled === condition.enabled) &&
    (condition.text === undefined || (!actual.textTruncated && actual.text === condition.text)) &&
    (!condition.attribute ||
      (!actual.attributeTruncated && actual.attribute === condition.attribute.value))
  );
}

export async function waitForObservation(
  session: BrowserSession,
  condition: ObservationCondition,
  signal: AbortSignal,
): Promise<void> {
  const timeoutMs = condition.timeoutMs ?? 5_000;
  const started = performance.now();
  let polls = 0;
  while (true) {
    signal.throwIfAborted();
    const actual = await session.sample(observeElement, condition);
    polls++;
    const matched = matchesObservation(condition, actual);
    if (matched || performance.now() - started >= timeoutMs) {
      const operationId = session.record("observe", `Observe ${condition.selector}`, {
        expected: condition,
        actual,
        matched,
        polls,
      });
      if (!matched)
        throw new BrowserBehaviorFailure(
          observationTimeoutMessage(condition, actual, timeoutMs),
          "timed-out",
          operationId,
        );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, timeoutMs)));
  }
}

function observationTimeoutMessage(
  condition: ObservationCondition,
  actual: ReturnType<typeof observeElement>,
  timeoutMs: number,
) {
  const message = `${condition.selector}: expected browser state was not observed within ${timeoutMs}ms.`;
  if (condition.text === undefined) return message;
  const truncation = actual.textTruncated ? " (truncated)" : "";
  return `${message} Text matches exactly: expected ${JSON.stringify(condition.text)}, observed ${JSON.stringify(actual.text)}${truncation}.`;
}

export async function scrollToElement(
  session: BrowserSession,
  action: { selector: string; block?: ScrollLogicalPosition; timeoutMs?: number },
  signal: AbortSignal,
): Promise<void> {
  const before = await session.sample(scrollPosition, action.selector);
  if (before.count !== 1)
    throw new BrowserBehaviorFailure(
      `${action.selector}: expected one scrolling target; found ${before.count}`,
    );
  await session.sample(({ selector, block }) => {
    document
      .querySelector(selector)
      ?.scrollIntoView({ block: block ?? "center", inline: "nearest", behavior: "instant" });
  }, action);
  const started = performance.now();
  let previous = before;
  let stable = 0;
  while (true) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = await session.sample(scrollPosition, action.selector);
    stable = JSON.stringify(previous) === JSON.stringify(after) ? stable + 1 : 0;
    const matched = stable >= 2 && after.inViewport;
    if (matched || performance.now() - started >= (action.timeoutMs ?? 2000)) {
      const operationId = session.record("scroll", `Scroll ${action.selector} into view`, {
        before,
        after,
        matched,
        block: action.block ?? "center",
      });
      if (!matched)
        throw new BrowserBehaviorFailure(
          `${action.selector}: scrolling did not settle on a visible viewport position`,
          "timed-out",
          operationId,
        );
      return;
    }
    previous = after;
  }
}

function scrollPosition(selector: string) {
  const elements = document.querySelectorAll(selector);
  const rect = elements.length === 1 ? elements[0]?.getBoundingClientRect() : undefined;
  return {
    count: elements.length,
    x: scrollX,
    y: scrollY,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    inViewport:
      !!rect &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth,
  };
}
