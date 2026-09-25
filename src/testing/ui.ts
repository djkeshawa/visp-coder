/// <reference lib="dom" />
import { assertControlReachable, type InteractionPage } from "./browser.js";

export interface UiRegion {
  readonly selector: string;
  readonly aspectRatio?: number;
  /** Absolute difference between rendered width/height and the promised ratio. */
  readonly tolerance?: number;
  readonly fullText?: boolean;
}

export interface UiStateContract {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly controls?: readonly {
    readonly selector: string;
    readonly minWidth?: number;
    readonly minHeight?: number;
  }[];
  readonly regions?: readonly UiRegion[];
  /** Vertical page scrolling is normal unless explicitly forbidden. */
  readonly forbidVerticalOverflow?: boolean;
}

export interface UiStateMeasurement {
  readonly name: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly elements: readonly {
    readonly selector: string;
    readonly width: number;
    readonly height: number;
  }[];
  readonly issues: readonly string[];
}

/** Check objective promises in the current state. Capture/review screenshots separately for taste. */
export async function assertUiState(
  page: Pick<InteractionPage, "evaluate">,
  contract: UiStateContract,
): Promise<UiStateMeasurement> {
  validate(contract);
  const measured = await page.evaluate(measureUiState, contract);
  const issues = [...measured.issues];
  for (const control of contract.controls ?? []) {
    try {
      await assertControlReachable(page, control.selector);
    } catch (error) {
      issues.push(String(error));
    }
  }
  if (issues.length) throw new Error(`${contract.name}: ${issues.join("; ")}`);
  return measured;
}

function validate(contract: UiStateContract): void {
  if (!contract.name.trim()) throw new Error("UI state needs a name");
  const count = (contract.controls?.length ?? 0) + (contract.regions?.length ?? 0);
  if (!count || count > 100)
    throw new Error("UI state needs at least one control or region (maximum 100)");
  for (const value of [contract.viewport.width, contract.viewport.height])
    positive(value, "viewport");
  for (const control of contract.controls ?? []) {
    if (control.minWidth !== undefined) positive(control.minWidth, "minWidth");
    if (control.minHeight !== undefined) positive(control.minHeight, "minHeight");
  }
  for (const region of contract.regions ?? []) validateRegion(region);
}

function validateRegion(region: UiRegion): void {
  if (region.aspectRatio !== undefined) positive(region.aspectRatio, "aspectRatio");
  if (
    region.tolerance !== undefined &&
    (!Number.isFinite(region.tolerance) || region.tolerance < 0)
  )
    throw new Error("tolerance must be finite and nonnegative");
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be finite and positive`);
}

/** Self-contained browser-side measurement; never rewrites or scrolls the page to make it pass. */
export function measureUiState(contract: UiStateContract): UiStateMeasurement {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const issues: string[] = [];
  const elements: Array<{ selector: string; width: number; height: number }> = [];
  inspectViewport();
  for (const control of contract.controls ?? []) inspectControl(control);
  for (const region of contract.regions ?? []) inspectRegion(region);
  return { name: contract.name, viewport, elements, issues };

  function inspectViewport() {
    if (
      Math.abs(viewport.width - contract.viewport.width) > 1 ||
      Math.abs(viewport.height - contract.viewport.height) > 1
    )
      issues.push(
        `Expected viewport ${contract.viewport.width}×${contract.viewport.height}, received ${viewport.width}×${viewport.height}`,
      );
    if (document.documentElement.scrollWidth > viewport.width + 0.5)
      issues.push("Horizontal document overflow");
    if (
      contract.forbidVerticalOverflow &&
      document.documentElement.scrollHeight > viewport.height + 0.5
    )
      issues.push("Vertical document overflow");
  }
  function inspectControl(control: NonNullable<UiStateContract["controls"]>[number]) {
    const element = locate(control.selector);
    if (!element) return;
    const rect = measure(element, control.selector);
    if (rect.width + 0.5 < (control.minWidth ?? 0) || rect.height + 0.5 < (control.minHeight ?? 0))
      issues.push(`${control.selector}: below declared minimum control size`);
  }
  function inspectRegion(region: UiRegion) {
    const element = locate(region.selector);
    if (!element) return;
    const rect = measure(element, region.selector);
    if (
      region.aspectRatio !== undefined &&
      Math.abs(rect.width / rect.height - region.aspectRatio) > (region.tolerance ?? 0.01)
    )
      issues.push(
        `${region.selector}: aspect ratio ${rect.width / rect.height} differs from ${region.aspectRatio}`,
      );
    if (
      region.fullText &&
      (element.scrollWidth > element.clientWidth + 0.5 ||
        element.scrollHeight > element.clientHeight + 0.5)
    )
      issues.push(`${region.selector}: required text or content is clipped`);
  }

  function locate(selector: string): Element | undefined {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) {
      issues.push(`${selector}: expected one element; found ${matches.length}`);
      return undefined;
    }
    return matches[0];
  }
  function measure(element: Element, selector: string): DOMRect {
    const rect = element.getBoundingClientRect();
    elements.push({ selector, width: rect.width, height: rect.height });
    if (rect.width <= 0 || rect.height <= 0) issues.push(`${selector}: no rendered area`);
    const { left, top, right, bottom } = bounds(element, selector);
    if (
      rect.left < left - 0.5 ||
      rect.top < top - 0.5 ||
      rect.right > right + 0.5 ||
      rect.bottom > bottom + 0.5
    )
      issues.push(`${selector}: clipped by its container or viewport`);
    return rect;
  }
  function bounds(element: Element, selector: string) {
    let left = 0,
      top = 0,
      right = viewport.width,
      bottom = viewport.height;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0)
        issues.push(`${selector}: element or ancestor is hidden`);
      if (current === element) continue;
      const box = current.getBoundingClientRect();
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
        left = Math.max(left, box.left + current.clientLeft);
        right = Math.min(right, box.left + current.clientLeft + current.clientWidth);
      }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
        top = Math.max(top, box.top + current.clientTop);
        bottom = Math.min(bottom, box.top + current.clientTop + current.clientHeight);
      }
    }
    return { left, top, right, bottom };
  }
}
