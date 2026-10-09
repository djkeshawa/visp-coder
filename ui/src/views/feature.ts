import type { UiFeature } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { clockTime, describeNext, executionWord, plural, relativeTime } from "../format.js";
import { renderMarkdown } from "../markdown.js";
import type { Actions, AppState, Tab } from "../state.js";
import { activityPanel, newActivityCount } from "./activity.js";
import { command, disclosure, resource } from "./parts.js";
import { progressPanel } from "./progress.js";
import { reviewPanel } from "./review.js";

export function featurePage(state: AppState, actions: Actions, id: string, tab: Tab): Node {
  return resource(state.features[id], "Loading feature", actions, (feature) =>
    h(
      "article",
      { class: "feature", "aria-labelledby": "feature-title" },
      header(feature, state, actions),
      nowBand(feature, actions),
      tabs(feature, state, actions, tab),
      h(
        "section",
        {
          class: "tab-panel",
          id: `panel-${tab}`,
          role: "tabpanel",
          "aria-labelledby": `tab-${tab}`,
        },
        panel(feature, state, actions, tab),
      ),
    ),
  );
}

function header(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const key = `request:${feature.id}`;
  return h(
    "header",
    { class: "feature-header" },
    h(
      "div",
      { class: "feature-heading" },
      h("h1", { id: "feature-title" }, feature.goal),
      h(
        "p",
        { class: "feature-meta" },
        h("span", null, feature.id),
        h("span", null, `Started ${relativeTime(feature.createdAt)}`),
        h("span", { title: feature.readAt }, `Read at ${clockTime(feature.readAt)}`),
      ),
    ),
    disclosure(
      key,
      h("span", null, "What you asked for"),
      () =>
        h(
          "blockquote",
          { class: "original-request" },
          feature.originalRequest,
          h("p", { class: "fine" }, "Kept verbatim. VISP never rewrites the original request."),
        ),
      actions,
      state.expanded.has(key),
      "request-disclosure",
    ),
  );
}

function nowBand(feature: UiFeature, actions: Actions): HTMLElement {
  const { headline, tone } = describeNext(feature.next);
  const satisfied = feature.outcomes.filter((outcome) => outcome.satisfied).length;
  const closed = feature.slices.filter(
    (slice) => slice.status === "closed" || slice.status === "legacy-closed",
  ).length;
  return h(
    "section",
    { class: `now tone-${tone}`, "aria-label": "What is happening now" },
    h(
      "div",
      { class: "now-main" },
      h("p", { class: "now-label" }, feature.lifecycle === "accepted" ? "Finished" : "Now"),
      h("h2", { class: "now-headline" }, headline),
      h("p", { class: "now-objective" }, feature.next.objective),
      feature.next.recovery && feature.next.recovery !== feature.next.objective
        ? h("p", { class: "now-recovery" }, feature.next.recovery)
        : null,
      feature.next.command && feature.next.action !== "complete"
        ? command(feature.next.command, actions, "The agent runs this next. You don't need to.")
        : null,
    ),
    h(
      "dl",
      { class: "now-facts" },
      fact("Outcomes met", `${satisfied} of ${feature.outcomes.length}`),
      fact("Slices closed", `${closed} of ${feature.slices.length}`),
      fact(
        "Open findings",
        String(feature.findings.length),
        feature.findings.length > 0 ? "warn" : "",
      ),
    ),
    thread(feature, actions),
  );
}

function fact(term: string, value: string, tone = ""): HTMLElement {
  return h("div", { class: `fact ${tone}` }, h("dt", null, term), h("dd", null, value));
}

/**
 * Every check run and review in order: the thread of the session. Each mark
 * opens what it stands for.
 */
function thread(feature: UiFeature, actions: Actions): HTMLElement | null {
  const runs = feature.executions.map((run) => ({ at: run.createdAt, kind: "run" as const, run }));
  const reviews = feature.reviews.map((review) => ({
    at: review.createdAt,
    kind: "review" as const,
    review,
  }));
  const marks = [...runs, ...reviews].sort((a, b) => a.at.localeCompare(b.at)).slice(-80);
  if (marks.length === 0) return null;
  return h(
    "div",
    { class: "thread" },
    h("p", { class: "thread-label", id: "thread-label" }, "Checks and reviews, oldest to newest"),
    h(
      "ol",
      { class: "thread-line", "aria-labelledby": "thread-label" },
      marks.map((mark) => {
        if (mark.kind === "review") {
          const label = `Review at ${clockTime(mark.at)}: ${plural(mark.review.findings, "finding")}`;
          const button = h("button", {
            class: `knot ${mark.review.findings > 0 ? "has-findings" : ""}`,
            type: "button",
            "aria-label": label,
            title: label,
          });
          button.addEventListener("click", () =>
            actions.navigate({ view: "feature", feature: feature.id, tab: "review" }),
          );
          return h("li", null, button);
        }
        const run = mark.run;
        const label = `${run.check}${run.task ? ` on ${run.task}` : ""}: ${executionWord(run.status)} at ${clockTime(run.createdAt)}${run.current ? "" : " (out of date)"}`;
        const button = h("button", {
          class: `bead status-${run.status} ${run.current ? "" : "is-stale"}`,
          type: "button",
          "aria-label": label,
          title: label,
        });
        button.addEventListener("click", () =>
          actions.navigate({ view: "feature", feature: feature.id, tab: "progress", run: run.id }),
        );
        return h("li", null, button);
      }),
    ),
  );
}

const TAB_NAMES: Record<Tab, string> = {
  progress: "Progress",
  review: "Review",
  activity: "Activity",
  handoff: "Handoff",
};

function tabs(feature: UiFeature, state: AppState, actions: Actions, current: Tab): HTMLElement {
  const counts: Partial<Record<Tab, number>> = {
    review: feature.findings.length,
    activity: newActivityCount(feature, state.seenBefore[feature.id]),
  };
  const order: Tab[] = ["progress", "review", "activity", "handoff"];
  const list = h(
    "div",
    { class: "tabs", role: "tablist", "aria-label": "Feature sections" },
    order.map((tab, index) => {
      const selected = tab === current;
      const count = counts[tab] ?? 0;
      const button = h(
        "button",
        {
          class: "tab",
          type: "button",
          role: "tab",
          id: `tab-${tab}`,
          "aria-selected": selected ? "true" : "false",
          "aria-controls": `panel-${tab}`,
          tabindex: selected ? 0 : -1,
          "data-key": `tab:${tab}`,
          title: `${TAB_NAMES[tab]} (${index + 1})`,
        },
        TAB_NAMES[tab],
        count > 0 ? h("span", { class: `tab-count tab-count-${tab}` }, String(count)) : null,
      );
      button.addEventListener("click", () =>
        actions.navigate({ view: "feature", feature: feature.id, tab }),
      );
      return button;
    }),
  );
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = order.indexOf(current);
    const next =
      order[(index + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length] ??
      current;
    event.preventDefault();
    actions.navigate({ view: "feature", feature: feature.id, tab: next });
  });
  return list;
}

function panel(feature: UiFeature, state: AppState, actions: Actions, tab: Tab): Node {
  if (tab === "review") return reviewPanel(feature, state, actions);
  if (tab === "activity") return activityPanel(feature, state, actions);
  if (tab === "handoff") return handoffPanel(feature, actions);
  return progressPanel(feature, state, actions);
}

function handoffPanel(feature: UiFeature, actions: Actions): HTMLElement {
  const copy = h("button", { class: "button", type: "button" }, icon("copy"), "Copy Markdown");
  copy.addEventListener("click", () => actions.copy(feature.report, copy));
  return h(
    "div",
    { class: "handoff" },
    h(
      "div",
      { class: "panel-intro" },
      h(
        "p",
        null,
        "The reviewer document, built from recorded evidence. It's what ",
        h("code", null, "visp pr"),
        " prints for the pull request.",
      ),
      copy,
    ),
    renderMarkdown(feature.report),
  );
}
