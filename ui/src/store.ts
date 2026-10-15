import { type AppState, initialState } from "./state.js";

/** The one page state; views read it, the modules beside this one change it. */
export const state: AppState = initialState();

/** Set when the next render should scroll to the top or move focus to the page. */
export const pending = { scrollTop: false, focusMain: false };

let renderer: (() => void) | undefined;
let renderQueued = false;

export function setRenderer(render: () => void): void {
  renderer = render;
}

export function schedule(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderer?.();
  });
}
