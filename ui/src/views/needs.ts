import type { RequestKind, UiRequest } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { fullTime, relativeTime, withQuotedAnswer } from "../format.js";
import type { Actions, AppState, NeedsFilter } from "../state.js";
import { command, empty, resource } from "./parts.js";

const KIND_ICON: Record<RequestKind, string> = {
  question: "question",
  handoff: "flag",
  acceptance: "check",
  environment: "alert",
  review: "review",
};

const KIND_NAMES: Record<RequestKind, string> = {
  question: "Questions",
  environment: "Environment",
  acceptance: "Ready to accept",
  handoff: "Handed off",
  review: "Review",
};

const KIND_EYEBROW: Record<RequestKind, string> = {
  question: "Question from the agent",
  environment: "Environment blocked a check",
  acceptance: "Ready for acceptance",
  handoff: "Handed over to you",
  review: "Review needs a person",
};

export function needsPage(state: AppState, actions: Actions): Node {
  const requests = state.requests.data?.requests ?? [];
  const filter = state.needsFilter;
  return h(
    "article",
    { class: "needs", "aria-labelledby": "needs-title" },
    h(
      "nav",
      { class: "needs-nav", "aria-label": "Request kinds" },
      h("h1", { id: "needs-title", class: "page-headline" }, "Needs you"),
      filterButton("all", "All open", requests.length, filter, actions),
      (Object.keys(KIND_NAMES) as RequestKind[]).map((kind) =>
        filterButton(
          kind,
          KIND_NAMES[kind],
          requests.filter((request) => request.kind === kind).length,
          filter,
          actions,
        ),
      ),
      h(
        "p",
        { class: "needs-note" },
        "The dashboard never acts for you. It builds the command; you run it, or answer in your agent's chat.",
      ),
      notificationControl(state, actions),
    ),
    h(
      "div",
      { class: "needs-list" },
      resource(state.requests, "Loading requests", actions, (data) => {
        const shown = data.requests.filter(
          (request) => filter === "all" || request.kind === filter,
        );
        return shown.length === 0
          ? h(
              "div",
              { class: "card card-body" },
              empty(
                "Nothing needs you right now",
                "When your agent asks a question or work is ready for your decision, it shows up here.",
              ),
            )
          : h(
              "ol",
              { class: "requests" },
              shown.map((request) => h("li", null, requestCard(request, state, actions))),
            );
      }),
    ),
  );
}

function filterButton(
  value: NeedsFilter,
  label: string,
  count: number,
  current: NeedsFilter,
  actions: Actions,
): HTMLElement {
  const button = h(
    "button",
    {
      class: `needs-filter ${count === 0 ? "is-empty" : ""}`,
      type: "button",
      "aria-pressed": value === current ? "true" : "false",
      "data-key": `needs-filter:${value}`,
    },
    h("span", null, label),
    h("span", { class: "mono" }, String(count)),
  );
  button.addEventListener("click", () => actions.filterNeeds(value));
  return button;
}

function notificationControl(state: AppState, actions: Actions): HTMLElement | null {
  if (state.notifications === "unsupported") return null;
  if (state.notifications === "granted")
    return h(
      "p",
      { class: "fine notify-state" },
      icon("bell"),
      "This browser will notify you when something new needs you.",
    );
  if (state.notifications === "denied")
    return h(
      "p",
      { class: "fine notify-state" },
      "Notifications are blocked for this page in your browser settings.",
    );
  const button = h("button", { class: "button", type: "button" }, icon("bell"), "Notify me here");
  button.addEventListener("click", () => actions.enableNotifications());
  return button;
}

function requestCard(request: UiRequest, state: AppState, actions: Actions): HTMLElement {
  return h(
    "article",
    { class: `card request kind-${request.kind}`, "aria-labelledby": `request-${request.id}` },
    h(
      "div",
      { class: "request-head" },
      h(
        "span",
        { class: "request-kind" },
        icon(KIND_ICON[request.kind]),
        KIND_EYEBROW[request.kind],
      ),
      h(
        "span",
        { class: "request-where" },
        h(
          "a",
          { href: `#/f/${encodeURIComponent(request.feature)}/now` },
          `${request.feature} · ${request.featureGoal}`,
        ),
        request.createdAt
          ? h(
              "span",
              { title: fullTime(request.createdAt) },
              ` · ${relativeTime(request.createdAt)}`,
            )
          : null,
      ),
    ),
    h(
      "div",
      { class: "request-body" },
      h(
        "h2",
        { id: `request-${request.id}`, class: "request-title" },
        request.question?.question ?? request.title,
      ),
      request.question
        ? questionBody(request, state, actions)
        : h("p", { class: "request-detail" }, request.detail),
      !request.question && request.command ? command(request.command, actions) : null,
    ),
  );
}

/**
 * The reply box builds a command with the answer safely quoted. Nothing is sent
 * from here: the answer only counts when it reaches VISP through the agent's
 * host or the pasted command.
 */
function questionBody(request: UiRequest, state: AppState, actions: Actions): HTMLElement {
  const question = request.question;
  if (!question) return h("div");
  const prefix = request.replyCommand ?? "visp critic feedback --reply";
  const key = `reply:${question.id}`;
  const draft = state.drafts[key] ?? "";
  const label = `reply-label-${question.id}`;
  const textarea = h("textarea", {
    class: "reply",
    rows: 3,
    "aria-labelledby": label,
    placeholder: "Type your answer",
    "data-key": key,
  });
  textarea.value = draft;
  const preview = draft.trim()
    ? command(
        withQuotedAnswer(prefix, draft),
        actions,
        "Paste this in a terminal in the repository.",
      )
    : h(
        "p",
        { class: "fine" },
        "Your answer is turned into a command you can paste. It's quoted so nothing in it runs.",
      );
  const holder = h("div", { class: "reply-command" }, preview);
  textarea.addEventListener("input", () => {
    actions.setDraft(key, textarea.value);
    holder.replaceChildren(
      textarea.value.trim()
        ? command(
            withQuotedAnswer(prefix, textarea.value),
            actions,
            "Paste this in a terminal in the repository.",
          )
        : h(
            "p",
            { class: "fine" },
            "Your answer is turned into a command you can paste. It's quoted so nothing in it runs.",
          ),
    );
  });
  return h(
    "div",
    { class: "question" },
    question.context ? h("p", { class: "fine" }, question.context) : null,
    h(
      "p",
      { class: "question-hint" },
      "Your agent is waiting for this in its chat. Answer there if you can see it.",
    ),
    h("label", { id: label, class: "reply-label" }, "Or answer here"),
    textarea,
    holder,
  );
}
