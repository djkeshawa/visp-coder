import { type RuleContext, resolveRule } from "./resolve.js";
import { EVALUATED_RULE_IDS, RULES, type RuleId } from "./rules.js";
import type { Override, Policy } from "./schema.js";

export interface RuleView {
  readonly id: RuleId;
  readonly title: string;
  readonly reason: string;
  readonly stage: string;
  readonly active: boolean;
  readonly why: string;
  readonly overridable: boolean;
  readonly evaluated: boolean;
}

export interface PolicyView {
  readonly strictness: string;
  readonly rules: readonly RuleView[];
}

/** Every rule, whether it applies now, and the plain reason it is on or off. */
export function explainRules(
  policy: Policy,
  overrides: readonly Override[],
  context: RuleContext,
): PolicyView {
  const rules: RuleView[] = RULES.map((rule) => {
    const resolved = resolveRule(rule.id, policy, overrides, context);

    return {
      id: rule.id,
      title: rule.title,
      reason: rule.reason,
      stage: rule.stage,
      active: resolved.active,
      overridable: rule.overridable,
      evaluated: EVALUATED_RULE_IDS.includes(rule.id),
      why: !EVALUATED_RULE_IDS.includes(rule.id)
        ? "catalogued; not evaluated by this workflow"
        : resolved.active
          ? "on"
          : resolved.reason === "overridden"
            ? `overridden: ${resolved.override.reason}`
            : policy.rules[rule.id] === false
              ? "off explicitly"
              : `off in ${policy.strictness} mode`,
    };
  });
  return { strictness: policy.strictness, rules };
}
