import type {
  UiEvidenceCount,
  UiExecutionSummary,
  UiFeature,
  UiOutcome,
  UiReview,
  UiTester,
} from "../../../src/ui/contract.js";
import { h } from "../dom.js";
import {
  clockTime,
  executionWord,
  plural,
  relativeTime,
  runShape,
  shortTime,
  type Tone,
} from "../format.js";
import type { Actions, AppState } from "../state.js";
import { cardHead, empty, pill, shape } from "./parts.js";
import { notesSection, slicesSection } from "./slices.js";

export function nowPanel(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "div",
    { class: "columns" },
    h(
      "div",
      { class: "column-main" },
      proofCard(feature, state, actions),
      threadCard(feature, actions),
      slicesSection(feature, state, actions),
      notesSection(feature),
    ),
    h(
      "aside",
      { class: "column-side", "aria-label": "Waiting on you, review and health" },
      needsCard(feature, state),
      reviewCard(feature),
      healthCard(feature, state),
    ),
  );
}

// ———— What is proven ————

function proofCard(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  const proven = feature.outcomes.filter((outcome) => outcome.satisfied).length;
  return h(
    "section",
    { class: "card proof", "aria-labelledby": "proof-title" },
    cardHead(
      "proof-title",
      "What is proven",
      "Each outcome from the request, and every independent source of evidence for it.",
      feature.outcomes.length > 0
        ? h(
            "p",
            { class: "card-count" },
            h("strong", null, String(proven)),
            ` of ${plural(feature.outcomes.length, "outcome")} proven`,
          )
        : null,
    ),
    testerStrip(feature, actions),
    feature.outcomes.length === 0
      ? h(
          "div",
          { class: "card-body" },
          empty(
            "No outcomes yet",
            "The agent defines outcomes in the brief before it builds anything.",
          ),
        )
      : matrix(feature, state, actions),
  );
}

/** The tester's suite covers the whole request, so it stands above the per-outcome rows. */
function testerStrip(feature: UiFeature, actions: Actions): HTMLElement {
  const tester = feature.tester;
  const run = tester.latest;
  const words = testerWords(tester);
  const open = run
    ? h(
        "button",
        { class: "link-button", type: "button", "data-key": `tester-run:${run.id}` },
        "Open the run",
      )
    : null;
  open?.addEventListener("click", () =>
    actions.navigate({ view: "feature", feature: feature.id, tab: "runs", run: run?.id }),
  );
  return h(
    "div",
    { class: `tester-strip tone-${words.tone}` },
    run ? shape(runShape(run.status), run.current ? "" : "is-stale") : shape("none"),
    h(
      "div",
      { class: "tester-text" },
      h(
        "p",
        null,
        h("span", { class: "strong" }, "Independent tests"),
        " cover the whole request · ",
        words.summary,
      ),
      run?.headline || tester.reason
        ? h("p", { class: "fine" }, run?.headline || tester.reason)
        : null,
    ),
    open,
  );
}

function testerWords(tester: UiTester): { summary: string; tone: Tone } {
  const run = tester.latest;
  const pinned = tester.tests > 0 ? `${plural(tester.tests, "test")} pinned` : "suite pinned";
  if (run && !run.current) return { summary: `${pinned}, latest run out of date`, tone: "neutral" };
  if (run)
    return {
      summary: `${pinned}, latest run ${executionWord(run.status).toLowerCase()}`,
      tone: run.status === "passed" ? "good" : run.status === "environment-failed" ? "warn" : "bad",
    };
  const words: Record<UiTester["status"], { summary: string; tone: Tone }> = {
    none: { summary: "no tester ran for this feature", tone: "neutral" },
    running: { summary: "the tester is writing the suite", tone: "live" },
    pinned: { summary: `${pinned}, not run yet`, tone: "neutral" },
    rejected: { summary: "the suite was rejected", tone: "warn" },
    failed: { summary: "the tester could not finish", tone: "warn" },
    declined: { summary: "the tester declined to write a suite", tone: "neutral" },
    unreadable: { summary: "the tester's record could not be read", tone: "warn" },
  };
  return words[tester.status];
}

function matrix(feature: UiFeature, state: AppState, actions: Actions): HTMLElement {
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      { class: "matrix" },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Outcome"),
          h("th", { scope: "col" }, "Agent checks"),
          h("th", { scope: "col" }, "Reviewer"),
          h("th", { scope: "col" }, "Verdict"),
        ),
      ),
      h(
        "tbody",
        null,
        feature.outcomes.map((outcome) => outcomeRows(feature.id, outcome, state, actions)),
      ),
    ),
  );
}

function outcomeRows(
  feature: string,
  outcome: UiOutcome,
  state: AppState,
  actions: Actions,
): HTMLElement[] {
  const key = `outcome:${feature}:${outcome.id}`;
  const open = state.expanded.has(key);
  const verdict = verdictOf(outcome);
  const toggle = h(
    "button",
    {
      class: "outcome-toggle",
      type: "button",
      "aria-expanded": open ? "true" : "false",
      "aria-controls": `detail-${outcome.id}`,
      "data-key": `toggle:${key}`,
    },
    h("span", { class: "chevron", "aria-hidden": "true" }),
    h("span", { class: "mono muted" }, outcome.id),
    h("span", { class: "outcome-statement" }, outcome.statement),
  );
  toggle.addEventListener("click", () => actions.toggle(key));
  const row = h(
    "tr",
    { class: `tone-row-${verdict.tone}` },
    h("th", { scope: "row" }, toggle),
    h("td", null, checksCell(outcome.checks, outcome.behavior)),
    h("td", null, reviewCell(outcome)),
    h("td", null, pill(verdict.tone, verdict.word)),
  );
  if (!open) return [row];
  return [
    row,
    h(
      "tr",
      { class: "outcome-detail-row", id: `detail-${outcome.id}` },
      h(
        "td",
        { colspan: 4 },
        h(
          "p",
          { class: "meta-row" },
          h("span", null, `${capitalize(outcome.kind)} outcome, ${outcome.priority}`),
          h("span", null, capitalize(provenanceLabel(outcome.provenance))),
          outcome.requiredReview ? h("span", null, "Review required") : null,
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
    ),
  ];
}

function verdictOf(outcome: UiOutcome): { word: string; tone: Tone } {
  if (outcome.satisfied) return { word: "Proven", tone: "good" };
  if (outcome.behavior === "failed" || outcome.review === "failed")
    return { word: "Failing", tone: "bad" };
  return { word: "Unproven", tone: "neutral" };
}

function checksCell(count: UiEvidenceCount, behavior: UiOutcome["behavior"]): HTMLElement {
  if (count.total === 0)
    return h("span", { class: "cell muted" }, shape("none"), "No check names it");
  const lines: [string, string, string][] = [];
  if (count.failed > 0) lines.push(["fail", `${count.failed} of ${count.total} fail`, ""]);
  if (count.passed > 0) lines.push(["pass", `${count.passed} of ${count.total} pass`, ""]);
  if (count.stale > 0)
    lines.push(["pass", `${count.stale} out of date`, "the product changed after the run"]);
  if (count.notRun > 0) lines.push(["none", `${count.notRun} not run`, ""]);
  const [first, ...rest] = lines;
  return h(
    "span",
    { class: `cell ${behavior === "failed" ? "is-bad" : ""}` },
    first ? [shape(first[0], first[1].includes("out of date") ? "is-stale" : ""), first[1]] : null,
    rest.map(([, text, note]) => h("span", { class: "cell-note", title: note || undefined }, text)),
  );
}

const REVIEW_WORDS: Record<UiOutcome["review"], { word: string; shape: string }> = {
  satisfied: { word: "Satisfied", shape: "judge-good" },
  failed: { word: "Failed", shape: "judge-bad" },
  unclear: { word: "Unclear", shape: "judge-warn" },
  unavailable: { word: "Couldn't assess", shape: "judge-warn" },
  unassessed: { word: "Not reviewed yet", shape: "none" },
};

function reviewCell(outcome: UiOutcome): HTMLElement {
  if (outcome.review === "unassessed" && !outcome.requiredReview)
    return h("span", { class: "cell muted" }, "Not required");
  const words = REVIEW_WORDS[outcome.review];
  return h(
    "span",
    { class: `cell ${outcome.review === "failed" ? "is-bad" : ""}` },
    shape(words.shape),
    words.word,
  );
}

const provenanceLabel = (value: string) =>
  value === "user-stated"
    ? "stated by you"
    : value === "independent"
      ? "independent"
      : value === "agent-proposed"
        ? "proposed by the agent"
        : value;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ———— The thread ————

interface Lane {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly marks: readonly Mark[];
}

type Mark =
  | { readonly kind: "run"; readonly at: string; readonly run: UiExecutionSummary }
  | { readonly kind: "review"; readonly at: string; readonly review: UiReview };

const MARKS_PER_LANE = 48;

function lanes(feature: UiFeature): Lane[] {
  const byLane = new Map<string, Mark[]>();
  const add = (lane: string, mark: Mark) => byLane.set(lane, [...(byLane.get(lane) ?? []), mark]);
  for (const run of feature.executions)
    add(run.source === "tester" ? "tester" : (run.task ?? ""), {
      kind: "run",
      at: run.createdAt,
      run,
    });
  for (const review of feature.reviews)
    add(review.task ?? "", { kind: "review", at: review.createdAt, review });
  const slices = new Map(feature.slices.map((slice) => [slice.id, slice]));
  const order = [...feature.slices.map((slice) => slice.id), "", "tester"];
  return order
    .filter((id) => byLane.has(id))
    .map((id) => {
      const slice = slices.get(id);
      const marks = (byLane.get(id) ?? [])
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-MARKS_PER_LANE);
      return {
        id,
        label: id === "tester" ? "Pinned" : id === "" ? "Feature" : id,
        note:
          id === "tester"
            ? "Independent tests"
            : slice
              ? `${slice.goal} · ${sliceWord(slice.status)}`
              : "Whole feature",
        marks,
      };
    });
}

const sliceWord = (status: UiFeature["slices"][number]["status"]) =>
  status === "in-progress"
    ? "in progress"
    : status === "pending"
      ? "not started"
      : status === "unknown"
        ? "unknown"
        : "closed";

function threadCard(feature: UiFeature, actions: Actions): HTMLElement | null {
  const all = lanes(feature);
  if (all.length === 0) return null;
  const working =
    feature.lifecycle !== "accepted" &&
    !["complete", "accept"].includes(feature.next.action) &&
    !feature.next.completion;
  return h(
    "section",
    { class: "card thread", "aria-labelledby": "thread-title" },
    cardHead(
      "thread-title",
      "The thread",
      "Every check run and review, by slice, oldest on the left. Select a mark to open it.",
      legend(),
    ),
    h(
      "ol",
      { class: "lanes" },
      all.map((lane) => {
        const current = lane.id !== "" && lane.id === feature.next.task;
        const first = lane.marks[0]?.at;
        const last = lane.marks.at(-1)?.at;
        return h(
          "li",
          { class: `lane ${current ? "is-current" : ""}` },
          h(
            "div",
            { class: "lane-name" },
            h("span", { class: "mono" }, lane.label),
            h("span", { class: "fine" }, lane.note),
          ),
          h(
            "ol",
            { class: "lane-marks", "aria-label": `${lane.label} runs and reviews` },
            lane.marks.map((mark) => h("li", null, markButton(feature, mark, actions))),
            current && working
              ? h(
                  "li",
                  { class: "lane-working" },
                  h("span", { class: "working-dot", "aria-hidden": "true" }),
                  "agent working",
                )
              : null,
          ),
          first && last
            ? h(
                "span",
                { class: "lane-time mono" },
                first === last ? shortTime(first) : `${shortTime(first)} to ${shortTime(last)}`,
              )
            : null,
        );
      }),
    ),
  );
}

function markButton(feature: UiFeature, mark: Mark, actions: Actions): HTMLElement {
  if (mark.kind === "review") {
    const label = `Review at ${clockTime(mark.at)}: ${plural(mark.review.findings, "finding")}`;
    const button = h(
      "button",
      { class: "mark-button", type: "button", "aria-label": label, title: label },
      shape("review"),
    );
    button.addEventListener("click", () =>
      actions.navigate({ view: "feature", feature: feature.id, tab: "review" }),
    );
    return button;
  }
  const run = mark.run;
  const label = `${run.check}${run.task ? ` on ${run.task}` : ""}: ${executionWord(run.status)} at ${clockTime(run.createdAt)}${run.current ? "" : " (out of date)"}`;
  const button = h(
    "button",
    {
      class: "mark-button",
      type: "button",
      "aria-label": label,
      title: label,
      "data-key": `mark:${run.id}`,
    },
    shape(runShape(run.status), run.current ? "" : "is-stale"),
  );
  button.addEventListener("click", () =>
    actions.navigate({ view: "feature", feature: feature.id, tab: "runs", run: run.id }),
  );
  return button;
}

function legend(): HTMLElement {
  const entries: [string, string, string][] = [
    ["pass", "", "passed"],
    ["fail", "", "failed"],
    ["timeout", "", "timed out"],
    ["env", "", "could not start"],
    ["review", "", "review"],
    ["pass", "is-stale", "out of date"],
  ];
  return h(
    "ul",
    { class: "legend", "aria-label": "Legend" },
    entries.map(([kind, extra, word]) => h("li", null, shape(kind, extra), word)),
  );
}

// ———— Side column ————

function needsCard(feature: UiFeature, state: AppState): HTMLElement {
  const requests = (state.requests.data?.requests ?? []).filter(
    (request) => request.feature === feature.id,
  );
  if (requests.length === 0)
    return h(
      "section",
      { class: "card side-card", "aria-labelledby": "needs-title" },
      h("h2", { id: "needs-title", class: "side-title" }, "Needs you"),
      h("p", { class: "fine" }, "Nothing on this feature is waiting for you."),
    );
  return h(
    "section",
    { class: "card needs-card", "aria-labelledby": "needs-title" },
    h(
      "div",
      { class: "needs-card-head" },
      h("h2", { id: "needs-title", class: "side-title" }, "Needs you"),
      h("span", { class: "mono" }, `${requests.length} open`),
    ),
    requests
      .slice(0, 3)
      .map((request) =>
        h(
          "div",
          { class: "needs-item" },
          h(
            "p",
            { class: "eyebrow warn" },
            KIND_WORDS[request.kind],
            request.createdAt ? ` · ${relativeTime(request.createdAt)}` : "",
          ),
          h("p", { class: "needs-item-title" }, request.question?.question ?? request.title),
          h(
            "a",
            { class: request.kind === "question" ? "button strong" : "text-link", href: "#/needs" },
            request.kind === "question" ? "Answer" : "See what to do",
          ),
        ),
      ),
    requests.length > 3
      ? h("a", { class: "text-link needs-more", href: "#/needs" }, `All ${requests.length}`)
      : null,
  );
}

const KIND_WORDS: Record<string, string> = {
  question: "Question from the agent",
  handoff: "Handed over to you",
  acceptance: "Ready for acceptance",
  environment: "Environment blocked a check",
  review: "Review needs a person",
};

function reviewCard(feature: UiFeature): HTMLElement {
  const required = feature.findings.filter((finding) => finding.required).length;
  const optional = feature.findings.length - required;
  const latest = feature.reviews[0];
  return h(
    "section",
    { class: "card side-card", "aria-labelledby": "review-title" },
    h(
      "div",
      { class: "side-head" },
      h("h2", { id: "review-title", class: "side-title" }, "Independent review"),
      h("a", { class: "text-link", href: `#/f/${encodeURIComponent(feature.id)}/review` }, "Open"),
    ),
    h(
      "div",
      { class: "tiles" },
      h(
        "div",
        { class: `tile ${required > 0 ? "tone-bad" : ""}` },
        h("span", { class: "tile-number" }, String(required)),
        h("span", { class: "tile-label" }, "must fix"),
      ),
      h(
        "div",
        { class: "tile" },
        h("span", { class: "tile-number" }, String(optional)),
        h("span", { class: "tile-label" }, "optional"),
      ),
    ),
    h(
      "p",
      { class: "fine" },
      latest
        ? `${plural(feature.reviews.length, "review")} so far · latest ${relativeTime(latest.createdAt)}${latest.reviewer?.model ? ` by ${latest.reviewer.model}` : ""}`
        : "No independent review has run yet.",
    ),
  );
}

function healthCard(feature: UiFeature, state: AppState): HTMLElement {
  const meta = state.meta.data;
  const tester = feature.tester;
  return h(
    "section",
    { class: "card side-card", "aria-labelledby": "health-title" },
    h(
      "div",
      { class: "side-head" },
      h("h2", { id: "health-title", class: "side-title" }, "Health"),
      h("a", { class: "text-link", href: "#/health" }, "Details"),
    ),
    h(
      "dl",
      { class: "facts" },
      meta ? fact("Build", `${meta.version}`, "mono") : null,
      fact("Updates", { live: "Live", connecting: "Connecting…", paused: "Paused" }[state.live]),
      fact(
        "Tester",
        tester.status === "pinned" && tester.at
          ? `Pinned ${plural(tester.tests, "test")} ${relativeTime(tester.at)}`
          : testerWords(tester).summary,
      ),
      fact("State read", relativeTime(feature.readAt)),
    ),
  );
}

function fact(term: string, value: string, extra = ""): HTMLElement {
  return h("div", null, h("dt", null, term), h("dd", { class: extra }, value));
}
