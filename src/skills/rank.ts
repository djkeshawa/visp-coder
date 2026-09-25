import { type ApplicationFacts, applicationOf } from "./applies.js";
import type { SkillRecord } from "./schema.js";

export interface SkillCandidate {
  readonly skill: SkillRecord;
  /** How many of the trigger's dimensions had to hold. Higher is more specific. */
  readonly specificity: number;
}

export interface SkillSelectionInput {
  /** Every skill on the index, in whatever state it is in. */
  readonly skills: readonly SkillRecord[];
  readonly facts: ApplicationFacts;
}

/**
 * Which learned skills apply here, best first.
 *
 * Only `admitted` is eligible. A proposal is something nobody has looked at, and
 * `rejected`, `retired` and `orphaned` are all decisions that it should not be
 * in front of an agent — so eligibility is an allow-list rather than a list of
 * states to skip, and a state added later is out until someone lets it in.
 *
 * Deliberately uncapped: the caller takes from the front until the pack is full,
 * so a skill that turns out to be unusable gives its place back instead of
 * spending it. Order is the more specifically targeted skill first — a trigger
 * naming paths and a task class said more about this task than one naming only a
 * stage. The id breaks the rest, so the same
 * library gives the same pack. Trust labels never establish measured usefulness.
 */
export function rankSkills(input: SkillSelectionInput): SkillCandidate[] {
  const candidates: SkillCandidate[] = [];

  for (const skill of input.skills) {
    if (skill.state !== "admitted") continue;

    const application = applicationOf(skill.appliesTo, input.facts);
    if (!application.applies) continue;

    candidates.push({ skill, specificity: application.matched.length });
  }

  return candidates.sort(
    (a, b) => b.specificity - a.specificity || compare(a.skill.id, b.skill.id),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
