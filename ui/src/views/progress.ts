import type { UiCheck, UiFeature, UiOutcome, UiSlice } from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import { executionTone, executionWord, relativeTime, type Tone } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { chips, disclosure, empty, mark, status } from "./parts.js";

export function progressPanel(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "div",
    { class: "progress" },
    outcomesSection(feature, state, actions),
    slicesSection(feature, state, actions),
    notesSection(feature),
  );
}

function outcomesSection(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "section",
    { class: "block", "aria-labelledby": "outcomes-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "outcomes-heading" }, "Outcomes"),
      h(
        "p",
        null,
        "What the work has to achieve. Met means executed checks passed and any required review agreed.",
      ),
    ),
    feature.outcomes.length === 0
      ? empty(
          "No outcomes yet",
          "The agent defines outcomes in the brief before it builds anything.",
        )
      : h(
          "ul",
          { class: "outcomes" },
          feature.outcomes.map((outcome) =>
            h("li", null, outcomeRow(feature.id, outcome, state, actions)),
          ),
        ),
  );
}

function outcomeRow(
  feature: string,
  outcome: UiOutcome,
  state: AppState,
  actions: Actions,
): HTMLElement {
  const key = `outcome:${feature}:${outcome.id}`;
  const summary = h(
    "span",
    { class: "outcome-summary" },
    mark(
      outcome.satisfied
        ? "good"
        : outcome.behavior === "failed" || outcome.review === "failed"
          ? "bad"
          : "neutral",
      outcome.satisfied ? "Met" : "Not met yet",
    ),
    h("span", { class: "outcome-text" }, outcome.statement),
    h(
      "span",
      { class: "outcome-evidence" },
      evidenceWord("Checks", behaviorTone(outcome.behavior), behaviorLabel(outcome.behavior)),
      outcome.requiredReview || outcome.review !== "unassessed"
        ? evidenceWord("Review", reviewTone(outcome.review), reviewLabel(outcome.review))
        : null,
    ),
  );
  return disclosure(
    key,
    summary,
    () =>
      h(
        "div",
        { class: "outcome-detail" },
        h(
          "p",
          { class: "meta-row" },
          h("span", { class: "chip" }, outcome.id),
          h("span", null, `${capitalize(outcome.kind)} outcome, ${outcome.priority}`),
          h("span", null, capitalize(provenanceLabel(outcome.provenance))),
        ),
        outcome.expectations.length > 0
          ? h(
              "ul",
              { class: "expectations" },
              outcome.expectations.map((expectation) =>
                h(
                  "li",
                  null,
                  h("span", { class: "chip" }, expectation.id),
                  " ",
                  expectation.statement,
                ),
              ),
            )
          : h("p", { class: "fine" }, "No separate expectations recorded."),
      ),
    actions,
    state.expanded.has(key),
    "outcome",
  );
}

function evidenceWord(label: string, tone: Tone, value: string): HTMLElement {
  return h(
    "span",
    { class: `evidence-word tone-${tone}` },
    h("span", { class: "evidence-label" }, label),
    value,
  );
}

const behaviorTone = (value: UiOutcome["behavior"]): Tone =>
  value === "passed" ? "good" : value === "failed" ? "bad" : "neutral";
const behaviorLabel = (value: UiOutcome["behavior"]) =>
  value === "passed" ? "passed" : value === "failed" ? "failing" : "no current run";
const reviewTone = (value: UiOutcome["review"]): Tone =>
  value === "satisfied"
    ? "good"
    : value === "failed"
      ? "bad"
      : value === "unclear"
        ? "warn"
        : "neutral";
const reviewLabel = (value: UiOutcome["review"]) =>
  value === "unassessed" ? "not reviewed" : value;
const provenanceLabel = (value: string) =>
  value === "user-stated"
    ? "stated by you"
    : value === "independent"
      ? "independent"
      : value === "agent-proposed"
        ? "proposed by the agent"
        : value;

function slicesSection(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "section",
    { class: "block", "aria-labelledby": "slices-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "slices-heading" }, "Slices"),
      h(
        "p",
        null,
        "Each slice is one usable piece of the work, built inside its own file scope and closed only when its checks pass.",
      ),
    ),
    feature.slices.length === 0
      ? empty("No slices yet", "Slices appear when the agent plans the work in its brief.")
      : h(
          "ol",
          { class: "slices" },
          feature.slices.map((slice) => h("li", null, sliceCard(feature, slice, state, actions))),
        ),
  );
}

const SLICE_STATUS: Record<UiSlice["status"], { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Not started" },
  "in-progress": { tone: "live", label: "In progress" },
  closed: { tone: "good", label: "Closed" },
  "legacy-closed": { tone: "good", label: "Closed" },
  unknown: { tone: "warn", label: "Unknown" },
};

function sliceCard(
  feature: UiFeature,
  slice: UiSlice,
  state: AppState,
  actions: Actions,
): HTMLElement {
  const info = SLICE_STATUS[slice.status];
  const key = `scope:${feature.id}:${slice.id}`;
  return h(
    "div",
    { class: `slice slice-${slice.status}` },
    h(
      "div",
      { class: "slice-head" },
      h("span", { class: "slice-id" }, slice.id),
      h("h3", null, slice.goal),
      status(info.tone, info.label),
    ),
    slice.checks.length === 0
      ? h(
          "p",
          { class: "fine slice-empty" },
          "No checks declared yet. VISP won't let the agent edit until one is.",
        )
      : h(
          "ul",
          { class: "checks" },
          slice.checks.map((check) => h("li", null, checkRow(feature.id, check, actions))),
        ),
    disclosure(
      key,
      h("span", null, "Scope and approach"),
      () => scopeDetail(slice),
      actions,
      state.expanded.has(key),
      "scope-disclosure",
    ),
  );
}

function checkRow(feature: string, check: UiCheck, actions: Actions): HTMLElement {
  const run = check.latest;
  const row = h(
    "button",
    {
      class: `check ${run ? `status-${run.status}` : "status-none"}`,
      type: "button",
      disabled: run ? undefined : true,
      "data-key": `check:${feature}:${check.id}`,
      "aria-label": run
        ? `${check.id}: ${executionWord(run.status)}. Open output`
        : `${check.id}: not run yet`,
    },
    run ? mark(executionTone(run.status), executionWord(run.status)) : mark("neutral", "Not run"),
    h(
      "span",
      { class: "check-body" },
      h(
        "span",
        { class: "check-line" },
        h("span", { class: "check-id" }, check.id),
        h("code", null, check.command),
      ),
      h(
        "span",
        { class: "check-result" },
        run ? run.headline || executionWord(run.status) : "Not run yet",
      ),
    ),
    h(
      "span",
      { class: "check-when" },
      run ? relativeTime(run.createdAt) : "",
      run && !run.current
        ? h(
            "span",
            { class: "stale-tag", title: "The product or the check changed after this run" },
            "out of date",
          )
        : null,
    ),
  );
  if (run)
    row.addEventListener("click", () =>
      actions.navigate({ view: "feature", feature, tab: "progress", run: run.id }),
    );
  return row;
}

function scopeDetail(slice: UiSlice): HTMLElement {
  const group = (label: string, values: readonly string[], note: string) =>
    h(
      "div",
      { class: "scope-group" },
      h("p", { class: "scope-label" }, label, h("span", { class: "fine" }, ` ${note}`)),
      values.length > 0
        ? h("div", { class: "paths" }, chips(values, "path"))
        : h("p", { class: "fine" }, "None"),
    );
  return h(
    "div",
    { class: "scope" },
    group("May change", slice.scope.allowed, "Edits outside these paths are refused."),
    group("Expected to change", slice.scope.expected, ""),
    group("Never change", slice.scope.forbidden, ""),
    slice.approach
      ? h(
          "div",
          { class: "scope-group" },
          h("p", { class: "scope-label" }, "Approach"),
          h("p", null, slice.approach),
        )
      : null,
    slice.dependsOn.length > 0
      ? h("p", { class: "fine" }, `Depends on ${slice.dependsOn.join(", ")}`)
      : null,
  );
}

function notesSection(feature: UiFeature): HTMLElement | null {
  if (feature.decisions.length === 0 && feature.uncertainties.length === 0) return null;
  return h(
    "section",
    { class: "block notes", "aria-labelledby": "notes-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "notes-heading" }, "Decisions and open questions"),
    ),
    feature.decisions.length > 0
      ? h(
          "ul",
          { class: "plain-list" },
          feature.decisions.map((entry) =>
            h("li", null, h("span", { class: "chip" }, entry.id), " ", entry.statement),
          ),
        )
      : null,
    feature.uncertainties.length > 0
      ? h(
          "div",
          null,
          h("p", { class: "scope-label" }, "Still uncertain"),
          h(
            "ul",
            { class: "plain-list" },
            feature.uncertainties.map((entry) => h("li", null, entry)),
          ),
        )
      : null,
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
