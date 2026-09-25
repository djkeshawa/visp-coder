/** Historical test-fixture builder; never used by the product workflow. */
import type { Candidate } from "./select.js";

const SIGNALS = ["task-term-match", "structural-neighbour", "entrypoint"] as const;
const RANK_OFFSET = 60;

/** Fuse independent optional-context signals; duplicate observations earn no extra weight. */
export function fusedScores(candidates: readonly Candidate[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const reason of SIGNALS) {
    const ranked = rankSignal(candidates, reason);
    let rank = 1;
    for (const [index, candidate] of ranked.entries()) {
      // Equal evidence gets equal weight; file naming only breaks final selection ties.
      if (index > 0 && candidate.order !== ranked[index - 1]?.order) rank = index + 1;
      scores.set(candidate.path, (scores.get(candidate.path) ?? 0) + 1 / (RANK_OFFSET + rank));
    }
  }
  return scores;
}

function rankSignal(candidates: readonly Candidate[], reason: Candidate["reason"]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    if (candidate.reason !== reason) continue;
    const previous = unique.get(candidate.path);
    if (!previous || candidate.order < previous.order) unique.set(candidate.path, candidate);
  }
  return [...unique.values()].sort(
    (a, b) => a.order - b.order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}
