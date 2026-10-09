import type { UiActivity, UiFeature } from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import { dayLabel, fullTime, shortTime } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { empty, mark } from "./parts.js";

/** Entries newer than the last time this feature's activity was opened. */
export function newActivityCount(feature: UiFeature, seenBefore: string | undefined): number {
  if (!seenBefore) return 0;
  return feature.activity.filter((entry) => entry.at > seenBefore).length;
}

export function activityPanel(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  if (feature.activity.length === 0)
    return empty(
      "Nothing recorded yet",
      "Checks, reviews and slice changes appear here as they happen.",
    );
  const seenBefore = state.seenBefore[feature.id];
  const groups = new Map<string, UiActivity[]>();
  for (const entry of feature.activity) {
    const day = dayLabel(entry.at);
    groups.set(day, [...(groups.get(day) ?? []), entry]);
  }
  let markerPlaced = false;
  return h(
    "div",
    { class: "activity" },
    [...groups].map(([day, entries]) =>
      h(
        "section",
        { class: "day", "aria-label": day },
        h("h2", { class: "day-label" }, day),
        h(
          "ol",
          { class: "timeline" },
          entries.map((entry) => {
            const isNew = seenBefore !== undefined && entry.at > seenBefore;
            const marker =
              !isNew &&
              !markerPlaced &&
              seenBefore !== undefined &&
              feature.activity[0]?.at !== entry.at;
            if (marker) markerPlaced = true;
            return [
              marker
                ? h(
                    "li",
                    { class: "since-marker" },
                    h("span", null, "Earlier than your last visit"),
                  )
                : null,
              h(
                "li",
                { class: `event kind-${entry.kind} ${isNew ? "is-new" : ""}` },
                eventRow(feature, entry, actions),
              ),
            ];
          }),
        ),
      ),
    ),
  );
}

function eventRow(feature: UiFeature, entry: UiActivity, actions: Actions): HTMLElement {
  const content = [
    h("time", { datetime: entry.at, title: fullTime(entry.at) }, shortTime(entry.at)),
    mark(
      entry.tone,
      entry.tone === "good"
        ? "Good"
        : entry.tone === "bad"
          ? "Problem"
          : entry.tone === "warn"
            ? "Attention"
            : "Event",
    ),
    h(
      "span",
      { class: "event-text" },
      h("span", { class: "event-title" }, entry.title),
      entry.detail ? h("span", { class: "event-detail" }, entry.detail) : null,
    ),
  ];
  if (!entry.execution) return h("div", { class: "event-row" }, content);
  const run = entry.execution;
  const button = h(
    "button",
    { class: "event-row is-link", type: "button", title: "Open output" },
    content,
  );
  button.addEventListener("click", () =>
    actions.navigate({ view: "feature", feature: feature.id, tab: "activity", run }),
  );
  return button;
}
