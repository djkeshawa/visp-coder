import type { ProductAssessment, ProductOutcome, ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

export function hasRequiredFindings(
  assessments: readonly ProductAssessment[],
  outcomes: readonly ProductOutcome[],
): boolean {
  return assessments.some(
    (assessment) =>
      outcomes.some(
        (outcome) => outcome.id === assessment.outcome && outcome.priority === "must",
      ) &&
      (assessment.status !== "satisfied" ||
        assessment.expectations.some((entry) => entry.status !== "satisfied")),
  );
}

/** Count assessed implementation changes following a failure; retries and unavailable reviews are not corrections. */
export function productRefinement(record: ProductRecord, slice?: ProductSlice) {
  const outcomes = record.brief.outcomes.filter(
    (outcome) => !slice || slice.outcomes.includes(outcome.id),
  );
  const relevant = new Set(
    outcomes.filter((outcome) => outcome.priority === "must").map((outcome) => outcome.id),
  );
  const corrections = new Set<string>();
  const pending = new Set<string>();
  const observed = new Map<string, string>();
  for (const review of record.state.reviews) {
    const implementation = review.implementationDigest ?? review.subjectDigest;
    let corrected = false;
    for (const entry of refinementEvents(review, relevant)) {
      if (observed.get(entry.key) !== implementation && pending.has(entry.key)) corrected = true;
      observed.set(entry.key, implementation);
      if (entry.failed) pending.add(entry.key);
      else pending.delete(entry.key);
    }
    if (corrected) corrections.add(implementation);
  }
  const used = corrections.size;
  const limit = record.brief.design?.refinementCycles ?? 2;
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    maximumFindings: 3 as const,
    exhausted: used >= limit,
  };
}

function refinementEvents(
  review: ProductRecord["state"]["reviews"][number],
  relevant: Set<string>,
) {
  const events = review.assessments
    .filter(
      (entry) => relevant.has(entry.outcome) && !["unavailable", "unclear"].includes(entry.status),
    )
    .map((entry) => ({
      key: entry.outcome,
      failed:
        entry.status === "failed" ||
        entry.expectations.some((expectation) => expectation.status === "failed"),
    }));
  if (review.feedback?.phase !== "product") return events;
  return [
    ...events,
    ...(review.feedback.probes ?? [])
      .filter((entry) => !["unclear", "unavailable"].includes(entry.status))
      .map((entry) => ({ key: `probe:${entry.kind}`, failed: entry.status === "failed" })),
    ...review.feedback.dimensions
      .filter((entry) => !["unavailable", "unclear"].includes(entry.status))
      .map((entry) => ({ key: `quality:${entry.dimension}`, failed: entry.status === "failed" })),
    ...review.feedback.findings
      .filter((entry) => entry.required)
      .map((entry) => ({ key: `finding:${entry.dimension}:${entry.problem}`, failed: true })),
  ];
}
