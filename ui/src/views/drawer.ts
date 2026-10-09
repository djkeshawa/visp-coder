import type { UiExecution } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import {
  bytes,
  duration,
  executionTone,
  executionWord,
  fullTime,
  isFailureLine,
  relativeTime,
  stripAnsi,
} from "../format.js";
import { type Actions, type AppState, executionKey } from "../state.js";
import { resource, status } from "./parts.js";

export function runDrawer(
  state: AppState,
  actions: Actions,
  feature: string,
  run: string,
): HTMLElement {
  const close = h(
    "button",
    {
      class: "icon-button drawer-close",
      type: "button",
      "aria-label": "Close output",
      "data-key": "drawer-close",
    },
    icon("close"),
  );
  close.addEventListener("click", () => closeDrawer(state, actions));
  const scrim = h("div", { class: "scrim" });
  scrim.addEventListener("click", () => closeDrawer(state, actions));
  return h(
    "div",
    { class: "drawer-layer" },
    scrim,
    h(
      "aside",
      { class: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "drawer-title" },
      h("div", { class: "drawer-top" }, h("h2", { id: "drawer-title" }, "Check output"), close),
      resource(
        state.executions[executionKey(feature, run)],
        "Loading output",
        actions,
        (execution) => runDetail(execution, state, actions),
      ),
    ),
  );
}

function closeDrawer(state: AppState, actions: Actions): void {
  if (state.route.view !== "feature") return;
  const { run: _run, ...rest } = state.route;
  actions.navigate(rest);
}

function runDetail(execution: UiExecution, state: AppState, actions: Actions): HTMLElement {
  const lines = stripAnsi(execution.output).replace(/\n$/, "").split("\n");
  const firstFailure = lines.findIndex((line) => isFailureLine(line));
  const output = h(
    "pre",
    {
      class: `output ${state.wrapOutput ? "is-wrapped" : ""}`,
      tabindex: 0,
      "aria-label": "Output",
    },
    lines.map((line, index) =>
      h(
        "span",
        { class: `line ${isFailureLine(line) ? "is-failure" : ""}`, id: `line-${index + 1}` },
        h("span", { class: "ln", "aria-hidden": "true" }, String(index + 1)),
        `${line}\n`,
      ),
    ),
  );
  const jump = h(
    "button",
    { class: "button", type: "button", disabled: firstFailure < 0 ? true : undefined },
    icon("down"),
    "First failure",
  );
  jump.addEventListener("click", () =>
    output.querySelector(`#line-${firstFailure + 1}`)?.scrollIntoView({ block: "center" }),
  );
  const wrap = h(
    "button",
    { class: "button", type: "button", "aria-pressed": state.wrapOutput ? "true" : "false" },
    icon("wrap"),
    "Wrap lines",
  );
  wrap.addEventListener("click", () => actions.toggleWrap());
  const copy = h("button", { class: "button", type: "button" }, icon("copy"), "Copy output");
  copy.addEventListener("click", () => actions.copy(stripAnsi(execution.output), copy));
  return h(
    "div",
    { class: "run" },
    h(
      "div",
      { class: "run-head" },
      status(executionTone(execution.status), executionWord(execution.status)),
      h(
        "p",
        { class: "run-title" },
        execution.check,
        execution.task ? h("span", { class: "fine" }, ` on ${execution.task}`) : null,
      ),
    ),
    execution.current
      ? null
      : h(
          "p",
          { class: "run-stale" },
          icon("clock"),
          "Out of date: the product, the slice or the check changed after this run. It no longer counts as evidence.",
        ),
    h("code", { class: "run-command" }, execution.command),
    h(
      "dl",
      { class: "run-facts" },
      fact("Ran", relativeTime(execution.createdAt), fullTime(execution.createdAt)),
      fact("Took", duration(execution.durationMs)),
      fact("Exit code", String(execution.exitCode)),
      fact(
        "Run by",
        execution.provenance === "supervisor-reused" ? "VISP (reused earlier result)" : "VISP",
      ),
      fact(
        "Assertions",
        execution.assertions === "runner-observed"
          ? "Observed by VISP's runner"
          : "Written by the agent",
      ),
      fact("Output", bytes(execution.outputBytes)),
    ),
    h("div", { class: "run-tools" }, jump, wrap, copy),
    execution.truncated
      ? h("p", { class: "fine" }, "Only the end of a very long output is shown.")
      : null,
    lines.length === 1 && lines[0] === ""
      ? h("p", { class: "fine" }, "The command printed nothing.")
      : output,
  );
}

function fact(term: string, value: string, title?: string): HTMLElement {
  return h("div", null, h("dt", null, term), h("dd", title ? { title } : null, value));
}
