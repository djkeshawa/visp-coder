import { h } from "../dom.js";
import type { Actions, AppState } from "../state.js";
import { command, empty, mark, resource } from "./parts.js";

export function healthPage(state: AppState, actions: Actions): Node {
  return h(
    "article",
    { class: "health", "aria-labelledby": "health-title" },
    h(
      "header",
      { class: "page-header" },
      h("h1", { id: "health-title" }, "Installation health"),
      h(
        "p",
        null,
        "The same checks as ",
        h("code", null, "visp doctor"),
        ". They look at hooks, state and configuration in this repository.",
      ),
    ),
    resource(state.health, "Running checks", actions, (health) =>
      h(
        "ul",
        { class: "health-list" },
        health.checks.map((check) => {
          const tone =
            check.status === "ok"
              ? "good"
              : check.status === "fail"
                ? "bad"
                : check.status === "warn"
                  ? "warn"
                  : "neutral";
          return h(
            "li",
            { class: `health-row tone-${tone}` },
            mark(tone, check.status),
            h(
              "div",
              null,
              h("p", { class: "health-name" }, capitalize(check.name)),
              h("p", { class: "fine" }, check.detail),
              check.recovery ? command(check.recovery, actions) : null,
            ),
          );
        }),
      ),
    ),
  );
}

export function homePage(state: AppState, actions: Actions): Node {
  return resource(state.overview, "Loading features", actions, (overview) =>
    overview.features.length === 0
      ? h(
          "article",
          { class: "welcome" },
          h("h1", null, "No features yet"),
          empty(
            "Waiting for your agent",
            "When your agent starts work with VISP, the feature, its checks and its reviews appear here as they happen.",
            command(
              'visp feature "<what you want built>"',
              actions,
              "Your agent usually runs this for you.",
            ),
          ),
        )
      : h("p", { class: "fine" }, "Choose a feature."),
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
