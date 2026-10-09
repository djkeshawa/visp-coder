import type { RequestKind, UiRequest } from "../../../src/ui/contract.js";
import { h, icon } from "../dom.js";
import { fullTime, relativeTime, withQuotedAnswer } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { command, empty, resource } from "./parts.js";

const KIND_ICON: Record<RequestKind, string> = {
  question: "question",
  handoff: "flag",
  acceptance: "check",
  environment: "alert",
  review: "review",
};

export function needsPage(state: AppState, actions: Actions): Node {
  return h(
    "article",
    { class: "needs", "aria-labelledby": "needs-title" },
    h(
      "header",
      { class: "page-header" },
      h("h1", { id: "needs-title" }, "Needs you"),
      h(
        "p",
        null,
        "Questions your agent asked and decisions VISP leaves to a person. This page only shows them; answer in your agent's chat or paste the command.",
      ),
      notificationControl(state, actions),
    ),
    resource(state.requests, "Loading requests", actions, (data) =>
      data.requests.length === 0
        ? empty(
            "Nothing needs you right now",
            "When your agent asks a question or work is ready for your decision, it shows up here.",
          )
        : h(
            "ol",
            { class: "requests" },
            data.requests.map((request) => h("li", null, requestCard(request, state, actions))),
          ),
    ),
  );
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
    { class: `request kind-${request.kind}` },
    h("div", { class: "request-icon" }, icon(KIND_ICON[request.kind])),
    h(
      "div",
      { class: "request-body" },
      h(
        "p",
        { class: "request-feature" },
        h(
          "a",
          { href: `#/f/${encodeURIComponent(request.feature)}/progress` },
          request.featureGoal,
        ),
        request.createdAt
          ? h("span", { title: fullTime(request.createdAt) }, relativeTime(request.createdAt))
          : null,
      ),
      h("h2", null, request.title),
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
    h("blockquote", { class: "question-text" }, question.question),
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
