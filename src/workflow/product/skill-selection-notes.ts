import type { ApplicationFacts } from "../../skills/applies.js";
import type { SkillCandidate } from "../../skills/rank.js";
import type { SkillRecord } from "../../skills/schema.js";

/** Explain bounded selection without treating unknown facts as a match. */
export function skillSelectionNotes(
  skills: readonly SkillRecord[],
  ranked: readonly SkillCandidate[],
  facts: ApplicationFacts,
): string[] {
  const matching = new Set(ranked.map(({ skill }) => skill.id));
  const excluded = skills.filter(
    (skill) =>
      skill.state === "orphaned" || (skill.state === "admitted" && !matching.has(skill.id)),
  );
  const notes = excluded.slice(0, 6).map((skill) => {
    if (skill.state === "orphaned")
      return `${skill.id}: learning support changed; excluded until reviewed readmission. Inspect its supporting work with visp skill show ${skill.id}.`;
    const unavailable = [
      ["task-class", skill.appliesTo?.taskClass.length, facts.taskClass],
      ["entrypoint", skill.appliesTo?.entrypointKind.length, facts.entrypointKinds],
      ["language", skill.appliesTo?.language.length, facts.languages],
    ]
      .filter(([, required, known]) => required && known === undefined)
      .map(([name]) => name);
    return `${skill.id}: trigger did not match current facts.${
      unavailable.length
        ? ` Required ${unavailable.join(", ")} facts are unavailable.`
        : ` Inspect its trigger with visp skill show ${skill.id}.`
    }`;
  });
  if (excluded.length > 6)
    notes.push(`${excluded.length - 6} additional skills were excluded; inspect visp skill list.`);
  return notes;
}
