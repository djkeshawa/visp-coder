import { productReviewChallenges } from "./coverage.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

export interface ProductReviewRecurrence {
  readonly id: string;
  readonly attempts: number;
  readonly reason: string;
  readonly recovery: string;
}

type Review = ProductRecord["state"]["reviews"][number];
interface RecurrenceCase {
  readonly attempts: number;
  readonly reason: string;
  readonly last: number;
}

/** Advisory feedback derived from persisted judgments; it never changes gates or correction budgets. */
export function productReviewRecurrence(
  record: ProductRecord,
  implementationDigest: string,
  slice?: ProductSlice,
): ProductReviewRecurrence[] {
  const required = new Set(
    record.brief.outcomes
      .filter(
        (outcome) => outcome.priority === "must" && (!slice || slice.outcomes.includes(outcome.id)),
      )
      .map((outcome) => outcome.id),
  );
  const challenges = new Map(
    productReviewChallenges(record, slice)
      .filter((challenge) => challenge.required)
      .map((challenge) => [challenge.id, challenge]),
  );
  const cases = new Map<string, RecurrenceCase>();
  for (const [index, review] of record.state.reviews.entries()) {
    if ((review.implementationDigest ?? review.subjectDigest) !== implementationDigest) {
      cases.clear();
      continue;
    }
    const owner = record.brief.slices.find((entry) => entry.id === review.task);
    if ((review.task && !owner) || review.reviewer?.context === "unavailable") continue;
    const allowed = new Set([...required].filter((id) => !owner || owner.outcomes.includes(id)));
    countReviewCases(review, index, allowed, challenges, cases);
  }
  return [...cases.entries()]
    .filter(([, entry]) => entry.attempts >= 2)
    .sort((a, b) => b[1].attempts - a[1].attempts || b[1].last - a[1].last)
    .slice(0, 3)
    .map(([id, entry]) => ({
      id,
      attempts: entry.attempts,
      reason: `${entry.attempts} failed judgments on the unchanged implementation. Latest: ${entry.reason}`,
      recovery:
        "Re-examine this case with a different hypothesis. A focused review using the host's configured model may help; repeat the relevant observation before making another judgment.",
    }));
}

function countReviewCases(
  review: Review,
  index: number,
  allowed: ReadonlySet<string>,
  challenges: ReadonlyMap<string, ReturnType<typeof productReviewChallenges>[number]>,
  cases: Map<string, RecurrenceCase>,
) {
  const explained = new Set<string>();
  for (const entry of new Map((review.coverage ?? []).map((entry) => [entry.id, entry])).values()) {
    const challenge = challenges.get(entry.id);
    if (!challenge?.outcomes.some((id) => allowed.has(id))) continue;
    if (entry.status === "failed") for (const id of challenge.outcomes) explained.add(id);
    rememberJudgment(cases, entry.id, entry.status, entry.reason, index);
  }
  for (const entry of new Map(review.assessments.map((entry) => [entry.outcome, entry])).values()) {
    if (!allowed.has(entry.outcome) || (entry.status === "failed" && explained.has(entry.outcome)))
      continue;
    rememberJudgment(cases, entry.outcome, entry.status, entry.summary, index);
  }
}

function rememberJudgment(
  cases: Map<string, RecurrenceCase>,
  id: string,
  status: string,
  reason: string,
  index: number,
) {
  if (status === "satisfied") cases.delete(id);
  if (status === "failed")
    cases.set(id, {
      attempts: (cases.get(id)?.attempts ?? 0) + 1,
      reason: reason.slice(0, 600),
      last: index,
    });
}
