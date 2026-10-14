import { h } from "./dom.js";

/** The live region screen readers listen to; the render module places it in the page. */
export const announcer = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });

export function announce(text: string): void {
  announcer.textContent = "";
  window.setTimeout(() => {
    announcer.textContent = text;
  }, 50);
}
