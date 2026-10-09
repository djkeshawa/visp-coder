import type { UiError } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import type { Tone } from "../format.js";
import type { Actions, AppState, Resource } from "../state.js";

const TONE_ICON: Record<Tone, string> = {
  good: "check",
  bad: "cross",
  warn: "alert",
  live: "dot",
  neutral: "dot",
};

/** A status is always a word plus a shape, never colour alone. */
export function status(tone: Tone, label: string, extra = ""): HTMLElement {
  return h(
    "span",
    { class: `status tone-${tone} ${extra}` },
    icon(TONE_ICON[tone]),
    h("span", null, label),
  );
}

export function mark(tone: Tone, label: string): HTMLElement {
  return h("span", { class: `mark tone-${tone}`, title: label }, icon(TONE_ICON[tone], label));
}

/**
 * A command the person may run. The page shows and copies it; it never runs it.
 */
export function command(text: string, actions: Actions, note?: string): HTMLElement {
  const button = h(
    "button",
    { class: "copy", type: "button", "aria-label": `Copy command: ${text}` },
    icon("copy"),
    h("span", { class: "copy-label" }, "Copy"),
  );
  button.addEventListener("click", () => actions.copy(text, button));
  return h(
    "div",
    { class: "command" },
    h("code", null, text),
    button,
    note ? h("p", { class: "command-note" }, note) : null,
  );
}

export function empty(title: string, body: string, extra?: Node): HTMLElement {
  return h(
    "div",
    { class: "empty" },
    h("p", { class: "empty-title" }, title),
    h("p", null, body),
    extra ?? null,
  );
}

export function failure(error: UiError, actions: Actions): HTMLElement {
  return h(
    "div",
    { class: "failure", role: "alert" },
    icon("alert"),
    h(
      "div",
      null,
      h("p", { class: "failure-title" }, headlineFor(error)),
      h("p", null, error.message),
      error.recovery ? command(error.recovery, actions) : null,
    ),
  );
}

function headlineFor(error: UiError): string {
  if (error.code === "OFFLINE") return "Can't reach the dashboard server";
  if (error.code === "STATE_BUSY") return "VISP is writing right now";
  if (error.code === "MIGRATION_REQUIRED") return "This feature uses an older format";
  if (error.code === "NOT_INITIALIZED") return "This repository isn't set up for VISP";
  if (error.code === "ARTIFACT_INVALID") return "A recorded file couldn't be read";
  return "Something couldn't be loaded";
}

export function loading(label: string): HTMLElement {
  return h(
    "div",
    { class: "loading", role: "status" },
    h("span", { class: "loading-bar" }),
    h("span", { class: "sr-only" }, label),
  );
}

/** Shows data, a failure, or a placeholder — never an empty success. */
export function resource<T>(
  value: Resource<T> | undefined,
  label: string,
  actions: Actions,
  render: (data: T) => Node,
): Node {
  if (value?.data !== undefined) return render(value.data);
  if (value?.error) return failure(value.error, actions);
  return loading(label);
}

export function disclosure(
  key: string,
  summary: Node | string,
  body: () => Node,
  actions: Actions,
  expanded: boolean,
  extraClass = "",
): HTMLElement {
  const id = `panel-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const toggle = h(
    "button",
    {
      class: "disclosure-toggle",
      type: "button",
      "aria-expanded": expanded ? "true" : "false",
      "aria-controls": id,
      "data-key": `toggle:${key}`,
    },
    h("span", { class: "chevron", "aria-hidden": "true" }),
    summary,
  );
  toggle.addEventListener("click", () => actions.toggle(key));
  return h(
    "div",
    { class: `disclosure ${extraClass} ${expanded ? "is-open" : ""}` },
    toggle,
    expanded ? h("div", { class: "disclosure-body", id }, body()) : null,
  );
}

export function chips(values: readonly string[], className = "chip"): HTMLElement[] {
  return values.map((value) => h("span", { class: className }, value));
}

const PREVIEW_LENGTH = 280;

/** Long recorded prose shows a preview first; the whole text is one click away. */
export function longText(key: string, text: string, state: AppState, actions: Actions): Node {
  if (text.length <= PREVIEW_LENGTH) return document.createTextNode(text);
  const open = state.expanded.has(key);
  const cut = text.lastIndexOf(" ", PREVIEW_LENGTH);
  const toggle = h(
    "button",
    { class: "more", type: "button", "aria-expanded": open ? "true" : "false", "data-key": key },
    open ? "Show less" : "Show all",
  );
  toggle.addEventListener("click", () => actions.toggle(key));
  return h(
    "span",
    null,
    open ? text : `${text.slice(0, cut > 0 ? cut : PREVIEW_LENGTH)}…`,
    " ",
    toggle,
  );
}
