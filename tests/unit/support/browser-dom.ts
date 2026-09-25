import { vi } from "vitest";

/** Minimal DOM boundary for deterministic geometry tests; browser tests verify real rendering. */
export function browserDom() {
  const rect = { x: 80, y: 80, width: 400, height: 240 };
  const style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    perspective: "none",
    rotate: "none",
    scale: "none",
  };
  const attributes: Record<string, string> = {};
  let hiddenByAncestor = false;
  const element = {
    textContent: "Ready" as string | null,
    disabled: false,
    inert: false,
    style,
    parentElement: null as object | null,
    getBoundingClientRect: () => ({
      ...rect,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
    }),
    contains: (other: unknown) => other === element,
    matches: () => element.disabled,
    closest: () => (element.inert ? element : null),
    getAttribute: (name: string) => attributes[name] ?? null,
    scrollIntoView: vi.fn(() => {
      rect.y = 200;
      vi.stubGlobal("scrollY", 400);
    }),
  };
  const document = {
    querySelectorAll: vi.fn((selector: string) =>
      selector === "#missing" ? [] : selector === "#ambiguous" ? [element, element] : [element],
    ),
    querySelector: vi.fn((selector: string) => (selector === "#missing" ? null : element)),
    elementFromPoint: vi.fn((): unknown => element),
    activeElement: null,
  };
  const computedStyle = (value: unknown) =>
    value === element ? style : { ...style, display: hiddenByAncestor ? "none" : "block" };
  vi.stubGlobal("document", document);
  vi.stubGlobal("getComputedStyle", computedStyle);
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800, getComputedStyle: computedStyle });
  return {
    rect,
    style,
    attributes,
    element,
    document,
    hideAncestor() {
      element.parentElement = { parentElement: null };
      hiddenByAncestor = true;
    },
  };
}
