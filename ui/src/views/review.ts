import type { Judgment, UiFeature, UiFinding, UiReview } from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import { executionWord, fullTime, plural, relativeTime, type Tone } from "../format.js";
import type { Actions, AppState } from "../state.js";
import { disclosure, empty, longText, mark } from "./parts.js";

const DIMENSION_NAMES: Record<string, string> = {
  fidelity: "Fidelity to the request",
  functional: "Behavior",
  "non-functional": "Reliability",
  experience: "Experience",
  code: "Code quality",
};

export function reviewPanel(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const [latest, ...earlier] = feature.reviews;
  return h(
    "div",
    { class: "review" },
    findingsSection(feature, state, actions),
    latest ? latestReview(latest) : null,
    earlier.length > 0 ? earlierReviews(feature.id, earlier, state, actions) : null,
    feature.captures.length > 0 ? capturesSection(feature) : null,
  );
}

function findingsSection(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const lastReview = feature.reviews[0];
  return h(
    "section",
    { class: "block", "aria-labelledby": "findings-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "findings-heading" }, "Open findings"),
      h(
        "p",
        null,
        "Raised by a reviewer that saw the request, the code and the executed evidence, but never the agent's own claims.",
      ),
    ),
    feature.findings.length > 0
      ? h(
          "ol",
          { class: "findings" },
          feature.findings.map((finding) =>
            h("li", null, findingCard(feature, finding, state, actions)),
          ),
        )
      : empty(
          "No open findings",
          lastReview
            ? `The latest review, ${relativeTime(lastReview.createdAt)}, left nothing open.`
            : "No independent review has run on this feature yet.",
        ),
  );
}

function findingCard(
  feature: UiFeature,
  finding: UiFinding,
  state: AppState,
  actions: Actions,
): HTMLElement {
  return h(
    "article",
    { class: `finding ${finding.required ? "is-required" : ""}` },
    h(
      "div",
      { class: "finding-head" },
      h("span", { class: "dimension" }, DIMENSION_NAMES[finding.dimension] ?? finding.dimension),
      finding.required
        ? h("span", { class: "required" }, "Must fix")
        : h("span", { class: "optional" }, "Suggested"),
      finding.task ? h("span", { class: "chip" }, finding.task) : null,
      finding.repeats > 1
        ? h("span", { class: "repeats" }, `Raised ${finding.repeats} times`)
        : null,
    ),
    h(
      "p",
      { class: "finding-problem" },
      longText(`problem:${finding.id}`, finding.problem, state, actions),
    ),
    h(
      "p",
      { class: "finding-next" },
      h("span", { class: "finding-next-label" }, "Check that would show it's fixed"),
      longText(`next:${finding.id}`, finding.nextCheck, state, actions),
    ),
    finding.evidence.length > 0 ? evidenceLinks(feature, finding.evidence, actions) : null,
  );
}

/** Evidence IDs that name a run or a check become links to that run's output. */
function evidenceLinks(feature: UiFeature, ids: readonly string[], actions: Actions): HTMLElement {
  return h(
    "p",
    { class: "evidence" },
    h("span", { class: "evidence-label" }, "Cites"),
    ids.map((id) => {
      const run =
        feature.executions.find((entry) => entry.id === id) ??
        feature.executions.find((entry) => entry.check === id);
      if (!run) return h("span", { class: "chip" }, id);
      const link = h(
        "button",
        { class: "chip chip-link", type: "button", title: `Open output (${id})` },
        `${run.check}${run.task ? ` on ${run.task}` : ""}, ${executionWord(run.status).toLowerCase()}`,
      );
      link.addEventListener("click", () =>
        actions.navigate({ view: "feature", feature: feature.id, tab: "review", run: run.id }),
      );
      return link;
    }),
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

function latestReview(review: UiReview): HTMLElement {
  return h(
    "section",
    { class: "block", "aria-labelledby": "latest-review-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "latest-review-heading" }, "Latest review"),
      h("p", { title: fullTime(review.createdAt) }, reviewByline(review)),
    ),
    review.summary ? h("p", { class: "review-summary" }, review.summary) : null,
    review.dimensions.length > 0
      ? h(
          "dl",
          { class: "dimensions" },
          review.dimensions.map((entry) =>
            h(
              "div",
              { class: "dimension-row" },
              h(
                "dt",
                null,
                mark(judgmentTone(entry.status), JUDGMENT_WORDS[entry.status]),
                DIMENSION_NAMES[entry.dimension] ?? entry.dimension,
              ),
              h(
                "dd",
                null,
                h(
                  "span",
                  { class: `judgment tone-${judgmentTone(entry.status)}` },
                  JUDGMENT_WORDS[entry.status],
                ),
                entry.reason,
              ),
            ),
          ),
        )
      : null,
    review.resolutions.length > 0
      ? h(
          "div",
          { class: "resolutions" },
          h("h3", null, `Closed in this review (${review.resolutions.length})`),
          h(
            "ul",
            { class: "plain-list" },
            review.resolutions.map((entry) =>
              h(
                "li",
                null,
                h(
                  "span",
                  { class: "chip" },
                  entry.disposition === "disproved" ? "Disproved" : "Repaired",
                ),
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
          { class: "limitations" },
          h("h3", null, "What the reviewer couldn't check"),
          h(
            "ul",
            { class: "plain-list" },
            review.limitations.map((entry) => h("li", null, entry)),
          ),
        )
      : null,
  );
}

function reviewByline(review: UiReview): string {
  const who = review.reviewer?.model
    ? `Reviewed by ${review.reviewer.model}`
    : "Independent review";
  const scope = review.task ? ` on ${review.task}` : "";
  return `${who}${scope}, ${relativeTime(review.createdAt)}. ${plural(review.findings, "finding")} raised.`;
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
    { class: "block" },
    disclosure(
      key,
      h("span", null, `Earlier reviews (${reviews.length})`),
      () =>
        h(
          "ol",
          { class: "earlier" },
          reviews.map((review) =>
            h(
              "li",
              null,
              h("p", { title: fullTime(review.createdAt) }, reviewByline(review)),
              review.summary ? h("p", { class: "fine" }, review.summary) : null,
            ),
          ),
        ),
      actions,
      state.expanded.has(key),
    ),
  );
}

function capturesSection(feature: UiFeature): HTMLElement {
  return h(
    "section",
    { class: "block", "aria-labelledby": "captures-heading" },
    h(
      "div",
      { class: "block-head" },
      h("h2", { id: "captures-heading" }, "Screens"),
      h(
        "p",
        null,
        "Screenshots VISP captured from browser journeys. The reviewer judged these, not the agent's description of them.",
      ),
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
