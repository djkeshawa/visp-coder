import type { ProductRecord } from "../workflow/product/store.js";
import type { UiActivity } from "./contract.js";
import { outputHeadline } from "./output.js";

/** Most recent first. Older entries stay in the recorded state and in `visp pr`. */
export const ACTIVITY_LIMIT = 400;

type State = ProductRecord["state"];

export function activityFor(record: ProductRecord): UiActivity[] {
  const { state } = record;
  const entries: UiActivity[] = [
    { at: state.createdAt, kind: "created", title: "Feature started", tone: "neutral" },
    ...sliceEntries(state),
    ...executionEntries(state),
    ...reviewEntries(state),
    ...revisionEntries(state),
    ...questionEntries(state),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_LIMIT);
}

const SLICE_WORDS: Record<string, string> = {
  pending: "reopened",
  "in-progress": "started",
  closed: "closed",
  "legacy-closed": "closed",
};

function sliceEntries(state: State): UiActivity[] {
  return state.sliceHistory.map((entry) => ({
    at: entry.createdAt,
    kind: "slice",
    title: `${entry.task} ${SLICE_WORDS[entry.to] ?? `moved to ${entry.to}`}`,
    detail: entry.reason,
    tone: entry.to === "closed" ? "good" : entry.to === "pending" ? "warn" : "neutral",
  }));
}

function executionEntries(state: State): UiActivity[] {
  return state.executions.map((execution) => {
    const where = execution.task ? `${execution.check} on ${execution.task}` : execution.check;
    const verb =
      execution.status === "passed"
        ? "passed"
        : execution.status === "failed"
          ? "failed"
          : "could not run";
    return {
      at: execution.createdAt,
      kind: "execution",
      title: `${where} ${verb}${execution.provenance === "supervisor-reused" ? " (reused)" : ""}`,
      detail: outputHeadline(execution.output, execution.status),
      tone: execution.status === "passed" ? "good" : execution.status === "failed" ? "bad" : "warn",
      execution: execution.id,
    };
  });
}

function reviewEntries(state: State): UiActivity[] {
  return state.reviews.map((review) => {
    const findings = review.feedback?.findings.length ?? 0;
    const resolved = review.feedback?.resolutions.length ?? 0;
    const parts = [
      findings === 0 ? "no findings" : `${findings} finding${findings === 1 ? "" : "s"}`,
      ...(resolved > 0 ? [`${resolved} resolved`] : []),
    ];
    return {
      at: review.createdAt,
      kind: "review",
      title: `Independent review${review.task ? ` of ${review.task}` : ""}: ${parts.join(", ")}`,
      ...(review.feedback?.summary ? { detail: review.feedback.summary } : {}),
      tone: findings === 0 ? "good" : "warn",
    };
  });
}

function revisionEntries(state: State): UiActivity[] {
  return state.revisions.map((revision) => ({
    at: revision.createdAt,
    kind: "revision",
    title: revision.kind === "intent" ? "Intent changed" : "Brief revised",
    // An intent change names who authorized it; VISP records that claim without verifying it.
    detail:
      revision.kind === "intent"
        ? `${revision.reason}. Authorized by ${revision.provenance} (claimed, not verified)`
        : revision.reason,
    tone: revision.kind === "intent" ? "warn" : "neutral",
  }));
}

function questionEntries(state: State): UiActivity[] {
  return (state.userFeedback ?? []).flatMap((entry): UiActivity[] => [
    {
      at: entry.createdAt,
      kind: "question",
      title: "Agent asked you a question",
      detail: entry.question,
      tone: "warn",
    },
    ...(entry.respondedAt
      ? [
          {
            at: entry.respondedAt,
            kind: "answer" as const,
            title: entry.status === "deferred" ? "Question deferred" : "Question answered",
            ...(entry.reply ? { detail: entry.reply } : {}),
            tone: "neutral" as const,
          },
        ]
      : []),
  ]);
}
