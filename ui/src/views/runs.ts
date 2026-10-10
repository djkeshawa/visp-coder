import type { UiExecution, UiExecutionSummary, UiFeature } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import {
  bytes,
  clockTime,
  duration,
  executionTone,
  executionWord,
  fullTime,
  isFailureLine,
  relativeTime,
  runShape,
  stripAnsi,
} from "../format.js";
import { type Actions, type AppState, executionKey, type RunsFilter } from "../state.js";
import { empty, resource, shape } from "./parts.js";

export function runsPanel(
  feature: UiFeature,
  state: AppState,
  actions: Actions,
  run: string | undefined,
): HTMLElement {
  return run ? runPage(feature, state, actions, run) : runList(feature, state, actions);
}

// ———— Every run ————

const FILTERS: [RunsFilter, string][] = [
  ["all", "All"],
  ["problems", "Problems"],
  ["tester", "Independent tests"],
];

function runList(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const filter = state.runsFilter;
  const runs = feature.executions.filter((run) =>
    filter === "problems"
      ? run.current && run.status !== "passed"
      : filter === "tester"
        ? run.source === "tester"
        : true,
  );
  return h(
    "section",
    { class: "card runs", "aria-labelledby": "runs-title" },
    h(
      "div",
      { class: "card-head" },
      h(
        "div",
        { class: "card-title" },
        h("h2", { id: "runs-title" }, "Runs"),
        h(
          "p",
          null,
          "Every check VISP ran, newest first. VISP's runner executes them; the agent only reports what it changed.",
        ),
      ),
      h(
        "div",
        { class: "segmented", role: "group", "aria-label": "Show runs" },
        FILTERS.map(([value, label]) => {
          const button = h(
            "button",
            {
              type: "button",
              "aria-pressed": value === filter ? "true" : "false",
              "data-key": `runs-filter:${value}`,
            },
            label,
          );
          button.addEventListener("click", () => actions.filterRuns(value));
          return button;
        }),
      ),
    ),
    runs.length === 0
      ? h(
          "div",
          { class: "card-body" },
          empty(
            filter === "all" ? "No runs yet" : "Nothing here",
            filter === "all"
              ? "Runs appear when the agent marks work done and VISP executes the slice's checks."
              : "No run matches this filter.",
          ),
        )
      : h(
          "div",
          { class: "table-scroll" },
          h(
            "table",
            { class: "run-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { scope: "col" }, "Result"),
                h("th", { scope: "col" }, "Check"),
                h("th", { scope: "col" }, "What it printed"),
                h("th", { scope: "col" }, "When"),
              ),
            ),
            h(
              "tbody",
              null,
              runs.map((run) => runRow(feature.id, run, actions)),
            ),
          ),
        ),
  );
}

function runRow(feature: string, run: UiExecutionSummary, actions: Actions): HTMLElement {
  const open = h(
    "button",
    {
      class: "row-link",
      type: "button",
      "data-key": `run:${run.id}`,
      "aria-label": `${run.check}${run.task ? ` on ${run.task}` : ""}: ${executionWord(run.status)}. Open output`,
    },
    shape(runShape(run.status), run.current ? "" : "is-stale"),
    h("span", null, executionWord(run.status)),
  );
  open.addEventListener("click", () =>
    actions.navigate({ view: "feature", feature, tab: "runs", run: run.id }),
  );
  return h(
    "tr",
    { class: run.current ? "" : "is-stale-row" },
    h("td", null, open),
    h(
      "td",
      null,
      h("span", { class: "mono" }, run.check),
      run.task ? h("span", { class: "fine" }, ` on ${run.task}`) : null,
      run.source === "tester" ? h("span", { class: "badge" }, "independent") : null,
    ),
    h(
      "td",
      { class: "run-headline" },
      run.headline || h("span", { class: "fine" }, "Printed nothing"),
      run.current ? null : h("span", { class: "stale-tag" }, "out of date"),
    ),
    h(
      "td",
      { class: "nowrap", title: fullTime(run.createdAt) },
      relativeTime(run.createdAt),
      h("span", { class: "fine" }, ` · ${duration(run.durationMs)}`),
    ),
  );
}

// ———— One run ————

function runPage(feature: UiFeature, state: AppState, actions: Actions, id: string): HTMLElement {
  const back = h(
    "a",
    { href: `#/f/${encodeURIComponent(feature.id)}/runs`, "data-key": "runs-back" },
    "Runs",
  );
  return h(
    "div",
    { class: "run-page" },
    h(
      "nav",
      { class: "breadcrumb", "aria-label": "Breadcrumb" },
      back,
      h("span", { "aria-hidden": "true" }, "/"),
      h("span", { class: "mono", "aria-current": "page" }, id),
    ),
    resource(state.executions[executionKey(feature.id, id)], "Loading output", actions, (run) =>
      runDetail(feature, run, state, actions),
    ),
  );
}

function runDetail(
  feature: UiFeature,
  run: UiExecution,
  state: AppState,
  actions: Actions,
): HTMLElement {
  const tone = executionTone(run.status);
  return h(
    "div",
    { class: "run-detail" },
    h(
      "section",
      { class: "card run-head", "aria-labelledby": "run-title" },
      h(
        "div",
        { class: "run-title-row" },
        h(
          "span",
          { class: `run-status tone-${tone}` },
          shape(runShape(run.status), "on-fill"),
          `${executionWord(run.status)} · exit ${run.exitCode}`,
        ),
        h(
          "h1",
          { id: "run-title" },
          run.check,
          run.task ? ` on ${run.task}` : "",
          run.headline ? h("span", { class: "run-title-headline" }, `: ${run.headline}`) : null,
        ),
      ),
      h("code", { class: "run-command" }, run.command),
      run.current
        ? null
        : h(
            "p",
            { class: "run-stale", role: "note" },
            icon("clock"),
            "Out of date: the product, the slice or the check changed after this run. It no longer counts as evidence.",
          ),
      h(
        "dl",
        { class: "run-facts" },
        fact("Ran", `${relativeTime(run.createdAt)} · ${clockTime(run.createdAt)}`),
        fact("Took", duration(run.durationMs)),
        fact(
          "Who ran it",
          run.provenance === "supervisor-reused"
            ? "VISP, reusing an earlier result"
            : "VISP's runner, not the agent",
        ),
        fact(
          "Assertions",
          run.source === "tester"
            ? "Written by the independent tester"
            : run.assertions === "runner-observed"
              ? "Observed by VISP's runner"
              : "Written by the agent",
        ),
        fact("Still current", run.current ? "Yes" : "No", run.current ? "good" : "warn"),
      ),
    ),
    h(
      "div",
      { class: "columns" },
      h("div", { class: "column-main" }, outputCard(run, state, actions)),
      h(
        "aside",
        { class: "column-side", "aria-label": "About this check" },
        historyCard(feature, run, actions),
        linksCard(feature, run, actions),
      ),
    ),
  );
}

function outputCard(run: UiExecution, state: AppState, actions: Actions): HTMLElement {
  const lines = stripAnsi(run.output).replace(/\n$/, "").split("\n");
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
        {
          class: `line ${isFailureLine(line) ? "is-failure" : /^NOT OBSERVED\b/.test(line) ? "is-unobserved" : ""}`,
          id: `line-${index + 1}`,
        },
        h("span", { class: "ln", "aria-hidden": "true" }, String(index + 1)),
        `${line}\n`,
      ),
    ),
  );
  const jump = h(
    "button",
    {
      class: "console-button",
      type: "button",
      disabled: firstFailure < 0 ? true : undefined,
      "data-key": "jump",
    },
    icon("down"),
    "First failure",
  );
  jump.addEventListener("click", () =>
    output.querySelector(`#line-${firstFailure + 1}`)?.scrollIntoView({ block: "center" }),
  );
  const wrap = h(
    "button",
    {
      class: "console-button",
      type: "button",
      "aria-pressed": state.wrapOutput ? "true" : "false",
      "data-key": "wrap",
    },
    icon("wrap"),
    "Wrap lines",
  );
  wrap.addEventListener("click", () => actions.toggleWrap());
  const copy = h(
    "button",
    { class: "console-button", type: "button", "data-key": "copy-output" },
    icon("copy"),
    h("span", { class: "copy-label" }, "Copy output"),
  );
  copy.addEventListener("click", () => actions.copy(stripAnsi(run.output), copy));
  const nothing = lines.length === 1 && lines[0] === "";
  return h(
    "section",
    { class: "console", "aria-labelledby": "output-title" },
    h(
      "div",
      { class: "console-bar" },
      h("h2", { id: "output-title" }, `Output · ${bytes(run.outputBytes)}`),
      h("div", { class: "console-tools" }, jump, wrap, copy),
    ),
    nothing ? h("p", { class: "console-note" }, "The command printed nothing.") : output,
    h(
      "p",
      { class: "console-foot" },
      "Recorded text is shown as text, never run.",
      run.truncated ? " Only the end of a very long output is shown." : "",
    ),
  );
}

function historyCard(feature: UiFeature, run: UiExecution, actions: Actions): HTMLElement {
  const same = feature.executions
    .filter((entry) => entry.check === run.check && entry.task === run.task)
    .reverse();
  return h(
    "section",
    { class: "card side-card", "aria-labelledby": "history-title" },
    h("h2", { id: "history-title", class: "side-title" }, "This check over time"),
    h(
      "ol",
      { class: "history" },
      same.map((entry) => {
        const label = `${executionWord(entry.status)} at ${clockTime(entry.createdAt)}${entry.current ? "" : " (out of date)"}`;
        const button = h(
          "button",
          {
            class: `mark-button ${entry.id === run.id ? "is-selected" : ""}`,
            type: "button",
            "aria-label": label,
            "aria-current": entry.id === run.id ? "true" : undefined,
            title: label,
          },
          shape(runShape(entry.status), entry.current ? "" : "is-stale"),
        );
        button.addEventListener("click", () =>
          actions.navigate({ view: "feature", feature: feature.id, tab: "runs", run: entry.id }),
        );
        return h("li", null, button);
      }),
    ),
    h(
      "p",
      { class: "fine" },
      same.length === 1
        ? "The only run of this check so far."
        : `${same.length} runs, oldest first.`,
    ),
    run.source === "tester"
      ? h(
          "p",
          { class: "fine" },
          "Pinned from the original request. The agent cannot edit this suite; it can dispute a failing test with a quoted reason.",
        )
      : null,
  );
}

function linksCard(feature: UiFeature, run: UiExecution, actions: Actions): HTMLElement | null {
  const findings = feature.findings.filter(
    (finding) => finding.evidence.includes(run.id) || finding.evidence.includes(run.check),
  );
  const outcomes = feature.outcomes.filter((outcome) =>
    feature.slices.some((slice) =>
      slice.checks.some((check) => check.id === run.check && check.outcomes.includes(outcome.id)),
    ),
  );
  if (findings.length === 0 && outcomes.length === 0) return null;
  return h(
    "section",
    { class: "card side-card", "aria-labelledby": "links-title" },
    h("h2", { id: "links-title", class: "side-title" }, "Linked to"),
    findings.map((finding) => {
      const link = h(
        "button",
        { class: "link-button", type: "button", "data-key": `finding-link:${finding.id}` },
        `Finding ${finding.id}${finding.required ? ", must fix" : ""}`,
      );
      link.addEventListener("click", () => {
        actions.selectFinding(feature.id, finding.id);
        actions.navigate({ view: "feature", feature: feature.id, tab: "review" });
      });
      return h("p", null, link);
    }),
    outcomes.map((outcome) =>
      h("p", { class: "fine" }, h("span", { class: "mono" }, outcome.id), ` ${outcome.statement}`),
    ),
  );
}

function fact(term: string, value: string, tone = ""): HTMLElement {
  return h(
    "div",
    null,
    h("dt", null, term),
    h("dd", { class: tone ? `tone-text-${tone}` : "" }, value),
  );
}
