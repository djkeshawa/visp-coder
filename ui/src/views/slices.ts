import type { UiCheck, UiFeature, UiSlice } from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import { executionTone, executionWord, relativeTime, type Tone } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { chips, disclosure, empty, mark, status } from "./parts.js";

export function slicesSection(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "section",
    { class: "card block", "aria-labelledby": "slices-heading" },
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
      actions.navigate({ view: "feature", feature, tab: "runs", run: run.id }),
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

export function notesSection(feature: UiFeature): HTMLElement | null {
  if (feature.decisions.length === 0 && feature.uncertainties.length === 0) return null;
  return h(
    "section",
    { class: "card block notes", "aria-labelledby": "notes-heading" },
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
