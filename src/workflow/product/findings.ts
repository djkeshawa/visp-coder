import { hashValue } from "../../core/hash.js";
import { productBehaviorProbes } from "./behavior-probes.js";
import type { ProductFeedback, QUALITY_DIMENSIONS } from "./feedback-model.js";
import type { ProductSlice } from "./model.js";
import type { ProductRecord } from "./store.js";

type Review = ProductRecord["state"]["reviews"][number];
type Finding = ProductFeedback["findings"][number];
type PendingFinding = Finding & {
  id: string;
  legacyId?: string;
  phase: ProductFeedback["phase"];
  subjectDigest: string;
  task?: string;
  repeats: number;
};

function feedbackPrompt(
  dimension: (typeof QUALITY_DIMENSIONS)[number],
  phase: ProductFeedback["phase"],
) {
  const prompts = {
    fidelity:
      "Compare the verbatim request with outcomes, examples and checks. Preserve experience words such as fun, intuitive or comfortable as observable user goals, not just palette or copy. Identify omitted promises or tests that could pass while the user goal fails.",
    functional:
      "Check preconditions, real input, intermediate transitions, terminal success AND failure, and recovery where relevant. Explain what would distinguish a correct result from a plausible fake. Check a relevant false positive and a legitimate success: changing mechanics to satisfy a fixed test route must not remove another promised behavior. Use actual execution and behavior, not test-source syntax.",
    "non-functional":
      "Assess the relevant reliability, performance, accessibility, security or environment promises. State applicability; do not invent a universal checklist.",
    experience:
      "For UI work compare the primary activity's usable area, status and controls with the retained design at each delivered viewport. Inspect the primary journey's actual input targets and intermediate feedback; a helper button or attractive palette does not establish usability. Assess composition, hierarchy, proportions and aspect ratio, material/character treatment and visual consistency against the requested experience; readability alone is not aesthetic refinement. Assess the first rendered slice before expanding content; theme compliance cannot substitute for appealing composition, expressive assets and appropriately scaled primary activity. Agent-proposed style techniques are revisable, not protected requirements. Keep unobserved promised inputs/viewports unresolved. Give at most three consequential corrections, not a styling checklist. Otherwise explain non-applicability.",
    code: "Inspect actual changed code for state ownership, lifecycle, duplication and readable responsibilities. Identify consequential maintainability issues; do not demand layers, file counts or abstraction for its own sake.",
  };
  return `${phase === "understanding" ? "Before the first substantial slice, assess the proposed approach and checks: " : "Assess the delivered product: "}${prompts[dimension]}`;
}

export function outstandingFeedback(record: ProductRecord) {
  const pending = new Map<string, PendingFinding>();
  const history = findingHistory(record);
  const collisions = legacyCollisions(history);
  for (const { review, findings } of history) {
    const feedback = review.feedback;
    if (!feedback) continue;
    for (const resolution of feedback.resolutions)
      resolveHistoricalFinding(pending, resolution.id, review.task);
    for (const finding of findings) {
      const legacyId = legacyFindingId(finding);
      const collision = collisions.has(legacyId);
      const id = findingId(record, review, finding, pending, collision);
      const previous = pending.get(id);
      const retained = retainedFinding(finding, previous, review, feedback.phase);
      pending.set(id, {
        ...retained,
        id,
        repeats: (previous?.repeats ?? 0) + 1,
        ...(collision ? { legacyId } : {}),
      });
    }
  }
  return [...pending.values()].sort(
    (a, b) => Number(b.required) - Number(a.required) || b.repeats - a.repeats,
  );
}

function findingHistory(record: ProductRecord) {
  return record.state.reviews.map((review) => ({
    review,
    findings: review.feedback ? reviewFindings(record, review, review.feedback) : [],
  }));
}

/** Describes ambiguous old identities without rewriting their reports or judgments. */
export function legacyFindingIdentityHistory(record: ProductRecord) {
  const history = findingHistory(record);
  const collisions = legacyCollisions(history);
  const aliases = new Map<string, { legacyId: string; id: string; task: string | null }>();
  for (const { review, findings } of history) {
    if (review.findingIdentityVersion === 2) continue;
    for (const finding of findings) {
      const legacyId = legacyFindingId(finding);
      if (!collisions.has(legacyId)) continue;
      const id = scopedFindingId(record, review, finding);
      aliases.set(id, { legacyId, id, task: review.task ?? null });
    }
  }
  const ambiguousResolutions = history.flatMap(({ review }, reviewIndex) =>
    (review.feedback?.resolutions ?? []).flatMap((resolution) => {
      if (!collisions.has(resolution.id)) return [];
      const owned = [...aliases.values()].some(
        (alias) => alias.legacyId === resolution.id && alias.task === review.task,
      );
      if (review.task && owned) return [];
      return [
        {
          reviewIndex,
          id: resolution.id,
          reason: review.task ? ("unknown-owner" as const) : ("missing-owner" as const),
        },
      ];
    }),
  );
  return { aliases: [...aliases.values()], ambiguousResolutions };
}

function retainedFinding(
  finding: Finding,
  previous: PendingFinding | undefined,
  review: Review,
  phase: ProductFeedback["phase"],
) {
  // Retain an unresolved required product report even when later advice weakens it.
  if (previous?.phase === "product" && (previous.required || phase === "understanding"))
    return previous;
  return {
    ...finding,
    phase,
    subjectDigest: review.subjectDigest,
    ...(review.task ? { task: review.task } : {}),
  };
}

function reviewFindings(
  record: ProductRecord,
  review: Review,
  feedback: ProductFeedback,
): Finding[] {
  const failures = feedback.dimensions
    .filter((entry) => entry.status === "failed")
    .map((entry) => ({
      dimension: entry.dimension,
      problem: entry.reason,
      nextCheck: feedbackPrompt(entry.dimension, feedback.phase),
      outcomes: [] as string[],
      required: true,
      evidence: entry.evidence,
    }));
  const probeFailures = (feedback.probes ?? [])
    .filter((entry) => entry.status === "failed")
    .map((entry) => ({
      dimension:
        entry.kind === "rendered-usability" ? ("experience" as const) : ("functional" as const),
      problem: `${entry.kind}: expected ${entry.expected}; observed ${entry.observed}`,
      nextCheck: entry.exercise,
      outcomes:
        productBehaviorProbes(
          record,
          record.brief.slices.find((slice) => slice.id === review.task),
        ).probes.find((probe) => probe.kind === entry.kind)?.outcomes ?? [],
      required: true,
      evidence: entry.evidence,
    }));
  return [...failures, ...feedback.findings, ...probeFailures];
}

function findingIdentity(finding: Finding) {
  return {
    dimension: finding.dimension,
    problem: finding.problem,
    outcomes: [...finding.outcomes].sort(),
  };
}

function legacyFindingId(finding: Finding) {
  return `FB-${hashValue(findingIdentity(finding)).slice(0, 16)}`;
}

function legacyCollisions(history: { review: Review; findings: Finding[] }[]) {
  const scopes = new Map<string, Set<string | undefined>>();
  for (const { review, findings } of history) {
    if (review.findingIdentityVersion === 2) continue;
    for (const finding of findings) {
      const id = legacyFindingId(finding);
      const owners = scopes.get(id) ?? new Set<string | undefined>();
      owners.add(review.task);
      scopes.set(id, owners);
    }
  }
  return new Set([...scopes].filter(([, owners]) => owners.size > 1).map(([id]) => id));
}

function resolveHistoricalFinding(
  pending: Map<string, PendingFinding>,
  id: string,
  task: string | undefined,
) {
  const exact = pending.get(id);
  if (exact && (!task || exact.task === task)) pending.delete(id);
  // Old IDs shared across scopes cannot identify an owner without a slice.
  if (!task) return;
  for (const [key, finding] of pending)
    if (finding.legacyId === id && finding.task === task) pending.delete(key);
}

function findingId(
  record: ProductRecord,
  review: Review,
  finding: Finding,
  pending: Map<string, PendingFinding>,
  collision: boolean,
) {
  const legacyId = legacyFindingId(finding);
  const legacyPending = pending.get(legacyId);
  return collision ||
    (review.findingIdentityVersion === 2 && (!legacyPending || legacyPending.task !== review.task))
    ? scopedFindingId(record, review, finding)
    : legacyId;
}

function scopedFindingId(record: ProductRecord, review: Review, finding: Finding) {
  return `FB-${hashValue({
    ...findingIdentity(finding),
    feature: record.brief.feature,
    task: review.task ?? null,
    version: 2,
  }).slice(0, 16)}`;
}

export function findingAppliesToSlice(
  finding: { task?: string; outcomes: readonly string[] },
  slice?: ProductSlice,
) {
  if (!slice) return true;
  if (finding.task) return finding.task === slice.id;
  return !finding.outcomes.length || finding.outcomes.some((id) => slice.outcomes.includes(id));
}
