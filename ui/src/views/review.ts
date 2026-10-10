import type { Judgment, UiFeature, UiFinding, UiReview } from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import { executionWord, fullTime, plural, relativeTime, runShape, type Tone } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { cardHead, disclosure, empty, longText, pill, shape } from "./parts.js";

const DIMENSION_NAMES: Record<string, string> = {
  fidelity: "Fidelity to the request",
  functional: "Behavior",
  "non-functional": "Reliability",
  experience: "Experience",
  code: "Code quality",
};

const dimensionName = (dimension: string) => DIMENSION_NAMES[dimension] ?? dimension;

export function reviewPanel(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const [latest, ...earlier] = feature.reviews;
  const selected = selectedFinding(feature, state);
  return h(
    "div",
    { class: "review" },
    reviewHeader(feature, latest),
    h(
      "div",
      { class: "columns review-columns" },
      h(
        "div",
        { class: "column-list" },
        findingList(feature, selected, actions),
        earlier.length > 0 ? earlierReviews(feature.id, earlier, state, actions) : null,
      ),
      h(
        "div",
        { class: "column-main" },
        selected ? findingDetail(feature, selected, state, actions) : null,
        latest ? judgments(latest) : null,
        feature.captures.length > 0 ? capturesCard(feature) : null,
      ),
    ),
  );
}

function selectedFinding(feature: UiFeature, state: AppState): UiFinding | undefined {
  const chosen = state.selectedFinding[feature.id];
  return (
    feature.findings.find((finding) => finding.id === chosen) ??
    feature.findings.find((finding) => finding.required) ??
    feature.findings[0]
  );
}

/** The review's outcome in one sentence, then who reviewed what and when. */
function reviewHeader(feature: UiFeature, latest: UiReview | undefined): HTMLElement {
  if (!latest)
    return h(
      "header",
      { class: "review-header" },
      h("h2", { class: "page-headline" }, "No independent review yet"),
      h(
        "p",
        { class: "lead" },
        "A reviewer that sees the request, the code and VISP's executed evidence, but never the agent's own claims, reviews each slice when its checks pass.",
      ),
    );
  const byline = [
    `Review ${feature.reviews.length}`,
    latest.task ? `slice ${latest.task}` : "",
    relativeTime(latest.createdAt),
    latest.reviewer?.model ?? "",
  ];
  return h(
    "header",
    { class: "review-header" },
    h(
      "p",
      { class: "hero-meta", title: fullTime(latest.createdAt) },
      byline.filter(Boolean).join(" · "),
    ),
    h("h2", { class: "page-headline" }, reviewHeadline(feature)),
    latest.summary ? h("p", { class: "lead" }, latest.summary) : null,
  );
}

function reviewHeadline(feature: UiFeature): string {
  const required = feature.findings.filter((finding) => finding.required).length;
  if (required > 0)
    return `${required === 1 ? "One thing" : `${required} things`} must change before acceptance`;
  return feature.findings.length > 0
    ? "Only optional suggestions are open"
    : "The latest review left nothing open";
}

function findingList(
  feature: UiFeature,
  selected: UiFinding | undefined,
  actions: Actions,
): HTMLElement {
  if (feature.findings.length === 0)
    return h(
      "div",
      { class: "card card-body" },
      empty("No open findings", "Nothing to fix from review."),
    );
  return h(
    "section",
    { "aria-labelledby": "findings-title" },
    h(
      "h2",
      { id: "findings-title", class: "eyebrow list-title" },
      `Open findings · ${feature.findings.length}`,
    ),
    h(
      "ol",
      { class: "finding-list" },
      feature.findings.map((finding) => {
        const isSelected = finding.id === selected?.id;
        const button = h(
          "button",
          {
            class: `finding-item ${isSelected ? "is-selected" : ""}`,
            type: "button",
            "aria-pressed": isSelected ? "true" : "false",
            "data-key": `finding:${finding.id}`,
          },
          h(
            "span",
            { class: "finding-tags" },
            pill(finding.required ? "bad" : "neutral", finding.required ? "Must fix" : "Optional"),
            h(
              "span",
              { class: "mono muted" },
              [finding.id, dimensionName(finding.dimension), ...finding.outcomes].join(" · "),
            ),
          ),
          h("span", { class: "finding-item-title" }, firstSentence(finding.problem)),
          h(
            "span",
            { class: "fine" },
            [
              finding.evidence.length > 0
                ? `Cites ${finding.evidence.map((id) => citation(feature, id)).join(", ")}`
                : "No evidence cited",
              finding.repeats > 1 ? `raised ${finding.repeats} times` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        button.addEventListener("click", () => actions.selectFinding(feature.id, finding.id));
        return h("li", null, button);
      }),
    ),
  );
}

/** A cited run reads as its check and slice; anything else is named as the reviewer gave it. */
function citation(feature: UiFeature, id: string): string {
  const run = feature.executions.find((entry) => entry.id === id);
  return run ? `${run.check}${run.task ? ` on ${run.task}` : ""}` : id;
}

/** A finding's first sentence names it in the list; the whole text is in the detail. */
function firstSentence(text: string): string {
  const match = /^(.{20,160}?[.!?])(\s|$)/.exec(text);
  const sentence = match?.[1] ?? text;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

function findingDetail(
  feature: UiFeature,
  finding: UiFinding,
  state: AppState,
  actions: Actions,
): HTMLElement {
  return h(
    "article",
    { class: "card finding-detail", "aria-labelledby": "finding-title" },
    h(
      "p",
      { class: "mono muted" },
      [
        finding.id,
        dimensionName(finding.dimension),
        finding.outcomes.length > 0 ? `outcome ${finding.outcomes.join(", ")}` : "",
        finding.task ? `slice ${finding.task}` : "",
        finding.repeats > 1
          ? `raised ${finding.repeats} times`
          : "first raised in the latest review",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    h("h2", { id: "finding-title", class: "finding-title" }, firstSentence(finding.problem)),
    // A one-sentence finding is already said in full by its title.
    firstSentence(finding.problem) === finding.problem.trim()
      ? null
      : h(
          "p",
          { class: "finding-problem" },
          longText(`problem:${finding.id}`, finding.problem, state, actions),
        ),
    h(
      "div",
      { class: "callout" },
      h("p", { class: "eyebrow accent" }, "How it will be shown fixed"),
      h("p", null, longText(`next:${finding.id}`, finding.nextCheck, state, actions)),
    ),
    finding.evidence.length > 0 ? evidence(feature, finding, actions) : null,
  );
}

/** Each cited run opens its output; other citations (files, lines) are named as given. */
function evidence(feature: UiFeature, finding: UiFinding, actions: Actions): HTMLElement {
  return h(
    "div",
    { class: "evidence" },
    h("h3", { class: "eyebrow" }, "Evidence the reviewer cites"),
    h(
      "ul",
      { class: "evidence-grid" },
      finding.evidence.map((id) => {
        const run =
          feature.executions.find((entry) => entry.id === id) ??
          feature.executions.find((entry) => entry.check === id);
        if (!run)
          return h("li", { class: "evidence-card is-plain" }, h("span", { class: "mono" }, id));
        const card = h(
          "button",
          { class: "evidence-card", type: "button", "data-key": `evidence:${finding.id}:${id}` },
          h(
            "span",
            { class: "evidence-meta" },
            shape(runShape(run.status), run.current ? "" : "is-stale"),
            `${run.check}${run.task ? ` on ${run.task}` : ""} · ${executionWord(run.status).toLowerCase()}${run.current ? "" : " · out of date"}`,
          ),
          h("code", null, run.command),
          run.headline ? h("span", { class: "fine" }, run.headline) : null,
        );
        card.addEventListener("click", () =>
          actions.navigate({ view: "feature", feature: feature.id, tab: "runs", run: run.id }),
        );
        return h("li", null, card);
      }),
    ),
  );
}

function judgmentTone(status: Judgment): Tone {
  if (status === "satisfied") return "good";
  if (status === "failed") return "bad";
  if (status === "unclear" || status === "unavailable") return "warn";
  return "neutral";
}

const JUDGMENT_WORDS: Record<Judgment, string> = {
  satisfied: "Satisfied",
  failed: "Failed",
  unclear: "Unclear",
  unavailable: "Couldn't assess",
  "not-applicable": "Not applicable",
};

const RESOLUTION_WORDS: Record<UiReview["resolutions"][number]["disposition"], string> = {
  repaired: "Repaired",
  disproved: "Disproved",
  "still-open": "Still open",
  "not-reproducible": "Not reproducible",
};

function judgments(review: UiReview): HTMLElement {
  return h(
    "section",
    { class: "card", "aria-labelledby": "judgments-title" },
    cardHead(
      "judgments-title",
      "The reviewer's judgments",
      `${review.task ? `For slice ${review.task}` : "For the feature"}, ${relativeTime(review.createdAt)}. ${plural(review.findings, "finding")} raised.`,
    ),
    review.dimensions.length > 0
      ? h(
          "div",
          { class: "table-scroll" },
          h(
            "table",
            { class: "judgments" },
            h(
              "tbody",
              null,
              review.dimensions.map((entry) => {
                const tone = judgmentTone(entry.status);
                return h(
                  "tr",
                  null,
                  h("th", { scope: "row" }, dimensionName(entry.dimension)),
                  h(
                    "td",
                    { class: `nowrap tone-text-${tone}` },
                    shape(`judge-${tone}`),
                    JUDGMENT_WORDS[entry.status],
                  ),
                  h("td", null, entry.reason),
                );
              }),
            ),
          ),
        )
      : null,
    h(
      "div",
      { class: "card-body stack" },
      review.resolutions.length > 0
        ? h(
            "div",
            null,
            h("h3", { class: "eyebrow" }, `Closed in this review · ${review.resolutions.length}`),
            h(
              "ul",
              { class: "plain-list" },
              review.resolutions.map((entry) =>
                h(
                  "li",
                  null,
                  h("span", { class: "chip" }, RESOLUTION_WORDS[entry.disposition]),
                  " ",
                  entry.explanation,
                ),
              ),
            ),
          )
        : null,
      review.limitations.length > 0
        ? h(
            "div",
            null,
            h("h3", { class: "eyebrow" }, "What the reviewer couldn't check"),
            h(
              "ul",
              { class: "plain-list" },
              review.limitations.map((entry) => h("li", null, entry)),
            ),
          )
        : null,
    ),
  );
}

function earlierReviews(
  feature: string,
  reviews: readonly UiReview[],
  state: AppState,
  actions: Actions,
): HTMLElement {
  const key = `earlier-reviews:${feature}`;
  return h(
    "section",
    { class: "earlier" },
    disclosure(
      key,
      h("span", null, `Earlier reviews · ${reviews.length}`),
      () =>
        h(
          "ol",
          { class: "earlier-list" },
          reviews.map((review, index) =>
            h(
              "li",
              { title: fullTime(review.createdAt) },
              h(
                "span",
                null,
                `Review ${reviews.length - index}`,
                review.task ? ` · ${review.task}` : "",
                ` · ${relativeTime(review.createdAt)}`,
              ),
              h(
                "span",
                { class: review.findings > 0 ? "" : "tone-text-good" },
                review.findings > 0 ? plural(review.findings, "finding") : "Satisfied",
              ),
            ),
          ),
        ),
      actions,
      state.expanded.has(key),
    ),
  );
}

function capturesCard(feature: UiFeature): HTMLElement {
  return h(
    "section",
    { class: "card", "aria-labelledby": "captures-title" },
    cardHead(
      "captures-title",
      "Screens",
      "Screenshots VISP captured from browser journeys. The reviewer judged these, not the agent's description of them.",
    ),
    h(
      "ul",
      { class: "captures" },
      feature.captures.slice(0, 24).map((capture) => {
        const src = `/captures/${encodeURIComponent(feature.id)}/${capture.path.split("/").map(encodeURIComponent).join("/")}`;
        return h(
          "li",
          null,
          h(
            "a",
            { href: src, target: "_blank", rel: "noopener" },
            h("img", { src, alt: `Capture ${capture.name}`, loading: "lazy" }),
            h("span", { class: "fine" }, capture.path),
          ),
        );
      }),
    ),
  );
}
