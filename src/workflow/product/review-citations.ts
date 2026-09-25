import type { IndependentReview } from "./independent-review.js";

/** Separate reviewer commentary from references; downstream identity/freshness validation is unchanged. */
export function normalizeIndependentEvidence(review: IndependentReview): IndependentReview {
  const limitations = [...review.limitations];
  function references(values: string[]) {
    const ids: string[] = [];
    const notes: string[] = [];
    for (const value of values) {
      // Only an explicit leading ID is a citation. Never infer evidence from prose or paths.
      const leading =
        /^(CODE-[a-f0-9]+|BRIEF-[a-f0-9]+|CAP-[a-f0-9-]+|SRC-REQUEST|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?=\s|:|$)/.exec(
          value,
        );
      const id = leading?.[1];
      if (id) {
        ids.push(id);
        const annotation = value.slice(id.length).replace(/^[:\s]+/, "");
        if (annotation) notes.push(`${id}: ${annotation}`);
      } else if (/^[A-Za-z]+(?:\s+[A-Za-z]+)/.test(value)) {
        // Plain sentences remain explicitly unverified commentary, never execution evidence.
        notes.push(value);
        limitations.push(`Unverified reviewer commentary supplied as evidence: ${value}`);
      } else {
        // Unknown IDs, malformed IDs and unselected images still reach the strict validator.
        ids.push(value);
      }
    }
    return { evidence: [...new Set(ids)], notes };
  }
  function judgment<
    T extends { status: IndependentReview["assessments"][number]["status"]; evidence: string[] },
  >(entry: T) {
    const normalized = references(entry.evidence);
    return {
      ...entry,
      evidence: normalized.evidence,
      status:
        entry.status === "satisfied" && !normalized.evidence.length
          ? ("unclear" as const)
          : entry.status,
      notes: normalized.notes,
    };
  }
  const assessments = review.assessments.map((entry) => {
    const { notes, ...assessment } = judgment(entry);
    return {
      ...assessment,
      summary: [assessment.summary, ...notes].join("\n"),
      expectations: entry.expectations.map((expectation) => {
        const { notes, ...result } = judgment(expectation);
        return { ...result, reason: [result.reason, ...notes].join("\n") };
      }),
    };
  });
  const findings = review.findings.map((finding) => {
    const { evidence, notes } = references(finding.evidence);
    return {
      ...finding,
      evidence,
      required: finding.required && evidence.length > 0,
      problem: [finding.problem, ...notes].join("\n"),
    };
  });
  // Resolutions are intentionally strict: prose cannot discharge a recorded failure.
  return { ...review, assessments, findings, limitations };
}
