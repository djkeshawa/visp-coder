import type { Stage, TaskClass } from "../core/constants.js";
import { matchesAny } from "../core/patterns.js";
import type { SkillAppliesTo } from "./schema.js";

/**
 * Whether a skill's trigger fires against the facts of the moment.
 *
 * Two decisions carry the weight here.
 *
 * The first is that a skill with no `appliesTo` applies nowhere. Defaulting to
 * everywhere is the tempting reading — the library was written to be used — but
 * the research on skill libraries is blunt that more is not monotonically
 * better: an uncurated library measurably degrades a strong model. An author
 * who has not said where a lesson belongs has not decided it belongs
 * everywhere, and reading silence as consent is how a library stops being
 * curated one skill at a time.
 *
 * The second is that a dimension the caller cannot answer never matches. There
 * is no index in a fresh clone, so no entrypoint kinds and no languages; a skill
 * that triggers on those must then stay out rather than be waved through on the
 * grounds that nothing contradicted it. Selection reports what it checked, not
 * what it assumed.
 */

export const APPLIES_DIMENSIONS = [
  "paths",
  "taskClass",
  "entrypointKind",
  "language",
  "stage",
] as const;
export type AppliesDimension = (typeof APPLIES_DIMENSIONS)[number];

export interface ApplicationFacts {
  /** The stages the material being assembled will serve. */
  readonly stages: readonly Stage[];
  /** Undefined before any task exists, which is exactly when `stage` earns its keep. */
  readonly taskClass?: TaskClass;
  /** The task's declared file scope: `allowedFiles` and `expectedFiles` together. */
  readonly scopePaths?: readonly string[];
  /** What the index found. Absent when there is no index to ask. */
  readonly entrypointKinds?: readonly string[];
  readonly languages?: readonly string[];
}

export interface Application {
  readonly applies: boolean;
  /** The dimensions the skill declared, all of which matched. */
  readonly matched: readonly AppliesDimension[];
}

/** Current product context serves implementation; retired drafting stages never select skills. */
export const SELECTING_STAGES: readonly Stage[] = ["context", "implement"];

const NOWHERE: Application = { applies: false, matched: [] };

/**
 * Whether a trigger could fire anywhere at all, as opposed to whether it fires
 * here. A trigger naming no dimension, or naming only stages nothing selects
 * at, is inert — and inert looks exactly like not-yet-matched unless it is said.
 */
export function couldFireAnywhere(appliesTo: SkillAppliesTo | undefined): boolean {
  if (!appliesTo) return false;

  const declared = APPLIES_DIMENSIONS.filter((dimension) => appliesTo[dimension].length > 0);
  if (declared.length === 0) return false;

  return (
    appliesTo.stage.length === 0 ||
    appliesTo.stage.some((stage) => SELECTING_STAGES.includes(stage))
  );
}

export function applicationOf(
  appliesTo: SkillAppliesTo | undefined,
  facts: ApplicationFacts,
): Application {
  if (!appliesTo) return NOWHERE;

  const matched: AppliesDimension[] = [];

  for (const dimension of APPLIES_DIMENSIONS) {
    if (appliesTo[dimension].length === 0) continue;
    if (!matches(dimension, appliesTo, facts)) return NOWHERE;
    matched.push(dimension);
  }

  return matched.length === 0 ? NOWHERE : { applies: true, matched };
}

function matches(
  dimension: AppliesDimension,
  appliesTo: SkillAppliesTo,
  facts: ApplicationFacts,
): boolean {
  switch (dimension) {
    case "paths":
      return (facts.scopePaths ?? []).some((entry) => covers(appliesTo.paths, entry));
    case "taskClass":
      return facts.taskClass !== undefined && contains(appliesTo.taskClass, facts.taskClass);
    case "entrypointKind":
      return (facts.entrypointKinds ?? []).some((kind) => contains(appliesTo.entrypointKind, kind));
    case "language":
      return (facts.languages ?? []).some((language) => contains(appliesTo.language, language));
    case "stage":
      return facts.stages.some((stage) => contains(appliesTo.stage, stage));
  }
}

/**
 * Whether a skill's path globs cover one entry of a task's declared scope.
 *
 * Both sides are globs, and deciding whether two glob sets genuinely intersect
 * is not something to approximate quietly — `src/auth/**` and `src/**` overlap,
 * but neither matches the other as a literal string. So this asks the narrower
 * question it can actually answer: does the task's scope entry, read as a path,
 * fall under one of the skill's globs?
 *
 * That is containment, not intersection, and it errs toward not firing: a skill
 * scoped more narrowly than the task will stay out of the pack. Silence is the
 * safe direction here — an absent skill costs nothing, while one that fires on
 * work it does not describe spends budget and can mislead.
 */
function covers(patterns: readonly string[], scopeEntry: string): boolean {
  return matchesAny(scopeEntry, patterns);
}

/** Widened to `string` so a fact from outside the enum simply fails to match. */
function contains(declared: readonly string[], value: string): boolean {
  return declared.includes(value);
}
