import type { FeatureSummary } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { relativeTime } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { currentTheme } from "../theme.js";

export function sidebar(state: AppState, actions: Actions): HTMLElement {
  const repo = state.meta.data?.repository.name ?? "";
  const needs = state.requests.data?.requests.length ?? 0;
  const route = state.route;
  return h(
    "nav",
    { class: "sidebar", "aria-label": "Dashboard" },
    h(
      "div",
      { class: "brand" },
      h("img", { src: "/symbol.svg", alt: "", width: 22, height: 22 }),
      h("span", { class: "brand-name" }, "visp"),
      h("span", { class: "brand-repo", title: state.meta.data?.repository.root ?? "" }, repo),
    ),
    h(
      "a",
      {
        class: `needs-link ${needs > 0 ? "has-needs" : ""}`,
        href: "#/needs",
        "aria-current": route.view === "needs" ? "page" : undefined,
        "data-key": "nav:needs",
      },
      icon("inbox"),
      h("span", null, "Needs you"),
      h("span", { class: "count", "aria-label": `${needs} waiting` }, String(needs)),
    ),
    h("p", { class: "nav-heading", id: "features-heading" }, "Features"),
    featureList(state, actions),
    h(
      "div",
      { class: "sidebar-foot" },
      h(
        "a",
        {
          class: "foot-link",
          href: "#/health",
          "aria-current": route.view === "health" ? "page" : undefined,
        },
        "Installation health",
      ),
      h("div", { class: "foot-row" }, liveIndicator(state), themeButton(actions)),
      state.meta.data ? h("p", { class: "version" }, `VISP ${state.meta.data.version}`) : null,
    ),
  );
}

function featureList(state: AppState, actions: Actions): HTMLElement {
  const features = state.overview.data?.features;
  if (!features) {
    return h(
      "p",
      { class: "nav-note" },
      state.overview.error ? "Features couldn't be read" : "Loading…",
    );
  }
  if (features.length === 0) return h("p", { class: "nav-note" }, "No features yet");
  const selected = state.route.view === "feature" ? state.route.feature : undefined;
  return h(
    "ul",
    { class: "feature-list", "aria-labelledby": "features-heading" },
    features.map((feature) =>
      h("li", null, featureLink(feature, feature.id === selected, actions)),
    ),
  );
}

function featureLink(feature: FeatureSummary, selected: boolean, actions: Actions): HTMLElement {
  const { total, closed } = feature.slices;
  const attention = feature.pendingQuestions + (feature.openFindings > 0 ? 1 : 0);
  const link = h(
    "a",
    {
      class: `feature-link lifecycle-${feature.lifecycle}`,
      href: `#/f/${encodeURIComponent(feature.id)}/progress`,
      "aria-current": selected ? "page" : undefined,
      "data-key": `nav:${feature.id}`,
    },
    h(
      "span",
      { class: "feature-link-top" },
      h("span", { class: "feature-goal" }, feature.goal),
      attention > 0 ? h("span", { class: "attention", "aria-label": "Needs attention" }) : null,
    ),
    h(
      "span",
      { class: "feature-link-meta" },
      lifecycleWord(feature),
      total > 0
        ? h(
            "span",
            { class: "slice-meter", "aria-label": `${closed} of ${total} slices closed` },
            meter(closed, total),
          )
        : null,
      feature.updatedAt ? h("span", { class: "when" }, relativeTime(feature.updatedAt)) : null,
    ),
  );
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    actions.navigate({ view: "feature", feature: feature.id, tab: "progress" });
  });
  return link;
}

function lifecycleWord(feature: FeatureSummary): HTMLElement {
  const words: Record<FeatureSummary["lifecycle"], string> = {
    active: feature.active ? "Active now" : "Open",
    accepted: "Accepted",
    "historical-complete": "Complete",
    legacy: "Older format",
    unreadable: "Can't read",
  };
  return h("span", { class: "lifecycle" }, words[feature.lifecycle]);
}

function meter(closed: number, total: number): HTMLElement[] {
  const cells = Math.min(total, 12);
  const filled = Math.round((closed / total) * cells);
  return Array.from({ length: cells }, (_, index) => h("i", { class: index < filled ? "on" : "" }));
}

function liveIndicator(state: AppState): HTMLElement {
  const words = { live: "Live", connecting: "Connecting…", paused: "Updates paused" } as const;
  return h(
    "span",
    { class: `live live-${state.live}`, role: "status", "aria-live": "polite" },
    h("span", { class: "live-dot", "aria-hidden": "true" }),
    words[state.live],
  );
}

function themeButton(actions: Actions): HTMLElement {
  const theme = currentTheme();
  const next = { system: "light", light: "dark", dark: "system" } as const;
  const button = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      "aria-label": `Theme: ${theme}. Switch to ${next[theme]}`,
      title: `Theme: ${theme}`,
      "data-key": "theme",
    },
    icon(theme === "light" ? "sun" : theme === "dark" ? "moon" : "auto"),
  );
  button.addEventListener("click", () => actions.cycleTheme());
  return button;
}
