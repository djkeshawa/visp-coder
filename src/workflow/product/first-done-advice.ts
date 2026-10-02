import { now } from "../artifacts/common.js";
import { closedSlice, type ProductSlice } from "./model.js";
import type { ProductAuthorization } from "./scopes.js";
import type { ProductNext } from "./status.js";
import type { ProductRecord } from "./store.js";

const FIRST_DONE_MINUTES = 15;

/** Advisory only: historical executions still count after further implementation edits. */
export function firstDoneAdvice(
  record: ProductRecord,
  slice: ProductSlice,
  authorization: ProductAuthorization | undefined,
  subject: string,
): string | undefined {
  if (
    record.state.status !== "active" ||
    closedSlice(record.state.slices[slice.id]?.status) ||
    authorization?.task !== slice.id
  )
    return undefined;
  const history = record.state.sliceHistory.findLast(
    (entry) => entry.task === slice.id && entry.to === "in-progress",
  );
  const authorizedAt = Date.parse(
    history?.createdAt || authorization.createdAt || record.state.createdAt,
  );
  // Repeated work refreshes the grant, but a run in the same open slice still counts.
  const executionStart = Date.parse(history?.createdAt || record.state.createdAt);
  const executed = record.state.executions.some(
    (entry) =>
      (entry.task === slice.id || (!entry.task && slice.checks.includes(entry.check))) &&
      (entry.subjectDigest === subject || Date.parse(entry.createdAt) >= executionStart),
  );
  const minutes = Math.floor((Date.parse(now()) - authorizedAt) / 60_000);
  if (executed || !Number.isFinite(minutes) || minutes < FIRST_DONE_MINUTES) return undefined;
  // done adds the pinned suite only for the last open slice (evidence.ts pinned check selection).
  const lastOpen = record.brief.slices.every(
    (entry) => entry.id === slice.id || closedSlice(record.state.slices[entry.id]?.status),
  );
  const pinned = lastOpen && record.brief.acceptanceBaseline.length > 0;
  return `No visp done yet after ${minutes} minutes: run it now. It runs your checks${pinned ? " and the pinned acceptance tests" : ""}, records the results and lists failures; no review call is spent while a check fails.`;
}

export function withFirstDoneAdvice(next: ProductNext, advice: string | undefined): ProductNext {
  return next.action === "implement" &&
    advice &&
    !next.evidence.some((entry) => entry.startsWith("No visp done yet after "))
    ? { ...next, evidence: [advice, ...next.evidence] }
    : next;
}
