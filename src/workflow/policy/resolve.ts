import type { Stage } from "../../core/constants.js";
import { defaultRuleState, findRule, RULES, type Rule, type RuleId } from "./rules.js";
import type { Override, Policy } from "./schema.js";

/** Where a rule is being evaluated, used to match override scopes. */
export interface RuleContext {
  readonly feature?: string;
  readonly task?: string;
  readonly stage?: Stage;
  /** Defaults to now; injectable so expiry is testable. */
  readonly at?: Date;
}

export type RuleState =
  | { readonly active: true; readonly rule: Rule }
  | { readonly active: false; readonly rule: Rule; readonly reason: "disabled" }
  | {
      readonly active: false;
      readonly rule: Rule;
      readonly reason: "overridden";
      readonly override: Override;
    };

/**
 * Whether a rule applies right now. A rule is active unless the policy turned it
 * off or a live, in-scope override waives it. Non-overridable rules ignore
 * overrides entirely.
 */
export function resolveRule(
  ruleId: RuleId,
  policy: Policy,
  overrides: readonly Override[],
  context: RuleContext = {},
): RuleState {
  const rule = findRule(ruleId);
  if (!rule) throw new Error(`Unknown rule: ${ruleId}`);

  if (!isEnabled(rule, policy)) return { active: false, rule, reason: "disabled" };
  if (!rule.overridable) return { active: true, rule };

  // `locked` is strict with the escape hatch welded shut: the same rules, and
  // no recorded exception waives any of them. Until this line the two tiers
  // were byte-identical — a documented four-position control with three
  // behaviours.
  if (policy.strictness === "locked") return { active: true, rule };

  const waiver = findApplicableOverride(ruleId, overrides, context);
  return waiver
    ? { active: false, rule, reason: "overridden", override: waiver }
    : { active: true, rule };
}

/** The policy's on/off decision for a rule, before overrides. */
export function isEnabled(rule: Rule, policy: Policy): boolean {
  const explicit = policy.rules[rule.id];
  if (explicit !== undefined) return explicit;
  return defaultRuleState(policy.strictness)[rule.id];
}

export function findApplicableOverride(
  ruleId: RuleId,
  overrides: readonly Override[],
  context: RuleContext = {},
): Override | undefined {
  const rule = findRule(ruleId);
  if (!rule?.overridable) return undefined;

  const at = context.at ?? new Date();
  return overrides.find(
    (override) =>
      override.rule === ruleId && isLive(override, at) && coversContext(override, context),
  );
}

function isLive(override: Override, at: Date): boolean {
  if (override.revokedAt) return false;
  return new Date(override.expiresAt).getTime() > at.getTime();
}

/**
 * An override with no scope applies project-wide. A scoped override applies only
 * where every field it names matches.
 */
function coversContext(override: Override, context: RuleContext): boolean {
  const { feature, task, stage } = override.scope;
  if (feature !== undefined && feature !== context.feature) return false;
  if (task !== undefined && task !== context.task) return false;
  if (stage !== undefined && stage !== context.stage) return false;
  return true;
}

/** Every rule the given stage evaluates, with its current state. */
export function resolveStage(
  stage: Stage,
  policy: Policy,
  overrides: readonly Override[],
  context: RuleContext = {},
): RuleState[] {
  return RULES.filter((rule) => rule.stage === stage).map((rule) =>
    resolveRule(rule.id, policy, overrides, { ...context, stage }),
  );
}

/**
 * Builds the context a rule is resolved against. Guard, verify and the gates all
 * go through this, because an override that waives a rule in one place and not
 * another is worse than no override at all.
 */
export function ruleContextFor(
  source: {
    status?: { activeFeature?: string; activeTask?: string };
  },
  explicit: { feature?: string; task?: string; stage?: Stage } = {},
): RuleContext {
  const feature = explicit.feature ?? source.status?.activeFeature;
  const task = explicit.task ?? source.status?.activeTask;

  return {
    ...(feature ? { feature } : {}),
    ...(task ? { task } : {}),
    ...(explicit.stage ? { stage: explicit.stage } : {}),
  };
}

export function activeRules(
  policy: Policy,
  overrides: readonly Override[],
  context: RuleContext = {},
): Rule[] {
  return RULES.filter((rule) => resolveRule(rule.id, policy, overrides, context).active);
}
