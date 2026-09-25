/// <reference lib="dom" />

export interface ControlMeasurement {
  readonly reachable: boolean;
  readonly focused: boolean;
  readonly x: number;
  readonly y: number;
  readonly reasons: readonly string[];
}

export interface ControlPointTarget {
  readonly selector: string;
  /** Fractions of the current CSS border box; only the selected point must be reachable. */
  readonly position: { readonly x: number; readonly y: number };
}

export interface ControlAbsolutePointTarget {
  readonly selector: string;
  /** Explicit CSS viewport coordinates, such as a drag origin. */
  readonly point: { readonly x: number; readonly y: number };
}

/** A structural adapter; Playwright Page fits without adding it as a dependency. */
export interface InteractionPage {
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  readonly mouse: {
    click(x: number, y: number): Promise<unknown>;
    move?(
      x: number,
      y: number,
      options?: { steps?: number; durationMs?: number },
    ): Promise<unknown>;
  };
  readonly touchscreen: { tap(x: number, y: number): Promise<unknown> };
  readonly keyboard: { press(key: string): Promise<unknown> };
}

/** Self-contained for page.evaluate. Checks the rendered main-frame control, not DOM presence. */
export function measureControl(
  target: string | ControlPointTarget | ControlAbsolutePointTarget,
): ControlMeasurement {
  const selected = typeof target === "string" ? { selector: target } : target;
  const { selector } = selected;
  const matches = document.querySelectorAll(selector);
  const element = matches[0];
  if (matches.length !== 1 || !element)
    return {
      reachable: false,
      focused: false,
      x: 0,
      y: 0,
      reasons: [`Expected one control; found ${matches.length}`],
    };
  const box = element.getBoundingClientRect();
  const { x, y, exact } = coordinates(selected, box);
  const reasons: string[] = [];
  const { left, top, right, bottom } = inspectAncestors(element);
  if (box.width <= 0 || box.height <= 0) reasons.push("Control has no rendered area");
  if (element.matches(":disabled, [aria-disabled='true']") || element.closest("[inert]"))
    reasons.push("Control is disabled or inert");
  const style = window.getComputedStyle(element);
  if (style.visibility !== "visible" || Number(style.opacity) === 0)
    reasons.push("Control is hidden");
  if (isClipped()) reasons.push("Control is clipped by its container or viewport");
  const hit = document.elementFromPoint(x, y);
  if (!hit || !element.contains(hit))
    reasons.push("Control is covered or cannot receive pointer input");
  return {
    reachable: reasons.length === 0,
    focused: element === document.activeElement || element.contains(document.activeElement),
    x,
    y,
    reasons,
  };

  function isClipped(): boolean {
    if (exact) return x < left || y < top || x >= right || y >= bottom;
    return (
      box.left < left - 0.5 ||
      box.top < top - 0.5 ||
      box.right > right + 0.5 ||
      box.bottom > bottom + 0.5
    );
  }

  // Keep browser-side helpers inside the serialized function.
  function coordinates(
    selection: {
      selector: string;
      position?: { x: number; y: number };
      point?: { x: number; y: number };
    },
    rect: DOMRect,
  ) {
    const offset = selection.position ?? { x: 0.5, y: 0.5 };
    return {
      x: selection.point?.x ?? rect.left + rect.width * offset.x,
      y: selection.point?.y ?? rect.top + rect.height * offset.y,
      exact: !!selection.point || !!selection.position,
    };
  }

  function inspectAncestors(target: Element) {
    const viewport = window.visualViewport ?? {
      offsetLeft: 0,
      offsetTop: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    };
    let left = viewport.offsetLeft;
    let top = viewport.offsetTop;
    let right = left + viewport.width;
    let bottom = top + viewport.height;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      if (style.display === "none" || Number(style.opacity) === 0)
        reasons.push("Control or ancestor is hidden");
      const rect = parent.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, rect.left + parent.clientLeft);
        right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, rect.top + parent.clientTop);
        bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
      }
    }
    return { left, top, right, bottom };
  }
}

export async function assertControlReachable(
  page: Pick<InteractionPage, "evaluate">,
  selector: string,
): Promise<ControlMeasurement> {
  const measured = await page.evaluate(measureControl, selector);
  if (!measured.reachable) throw new Error(`${selector}: ${measured.reasons.join("; ")}`);
  return measured;
}

/** Uses browser input, never element.click(). Assert the resulting application state separately. */
export async function activateControl(
  page: InteractionPage,
  selector: string,
  input: "pointer" | "touch" | "keyboard",
  maxTabs = 50,
  key: "Enter" | "Space" = "Enter",
): Promise<void> {
  let measured = await assertControlReachable(page, selector);
  if (input === "pointer") {
    await page.mouse.move?.(measured.x, measured.y);
    const after = await page.evaluate(measureControl, {
      selector,
      point: { x: measured.x, y: measured.y },
    });
    if (!after.reachable)
      throw new Error(
        `${selector}: intended click point is no longer reachable: ${after.reasons.join("; ")}`,
      );
    await page.mouse.click(measured.x, measured.y);
    return;
  }
  if (input === "touch") {
    await page.touchscreen.tap(measured.x, measured.y);
    return;
  }
  if (input !== "keyboard") throw new Error(`Unsupported input: ${input}`);
  if (key !== "Enter" && key !== "Space") throw new Error(`Unsupported activation key: ${key}`);
  if (!Number.isSafeInteger(maxTabs) || maxTabs < 0)
    throw new Error("maxTabs must be a nonnegative safe integer");
  for (let tabs = 0; !measured.focused && tabs < maxTabs; tabs++) {
    await page.keyboard.press("Tab");
    measured = await assertControlReachable(page, selector);
  }
  if (!measured.focused)
    throw new Error(`${selector}: not reachable by keyboard within ${maxTabs} tabs`);
  await page.keyboard.press(key);
}
