import { describe, expect, it } from "vitest";
import { activeRules, resolveRule, resolveStage } from "../../../../src/workflow/policy/resolve.js";
import { defaultRuleState } from "../../../../src/workflow/policy/rules.js";
import type { Override, Policy } from "../../../../src/workflow/policy/schema.js";

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    kind: "policy",
    createdAt: "2026-01-01T00:00:00.000Z",
    strictness: "standard",
    rules: {},
    ...overrides,
  };
}

function override(entry: Partial<Override> = {}): Override {
  return {
    id: "OV1",
    rule: "scope.allowed-files",
    reason: "Deliberate cross-cutting rename approved in review",
    scope: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-31T00:00:00.000Z",
    ...entry,
  };
}

const at = new Date("2026-06-01T00:00:00.000Z");

describe("defaultRuleState", () => {
  it("enables only the non-waivable rules in relaxed mode", () => {
    const state = defaultRuleState("relaxed");
    expect(state["scope.forbidden-paths"]).toBe(true);
    expect(state["gate.stop-on-failure"]).toBe(true);
    expect(state["scope.allowed-files"]).toBe(false);
    expect(state["contract.executable-evidence"]).toBe(true);
  });

  it("adds scope and evidence rules at standard", () => {
    const state = defaultRuleState("standard");
    expect(state["scope.allowed-files"]).toBe(true);
    expect(state["evidence.verify-passed"]).toBe(true);
    expect(state["evidence.test-signal"]).toBe(false);
  });

  it("adds the demanding rules at strict", () => {
    const state = defaultRuleState("strict");
    expect(state["evidence.test-signal"]).toBe(true);
    expect(state["tasks.traceable"]).toBe(true);
    expect(state["deps.declared"]).toBe(true);
  });
});

describe("resolveRule", () => {
  it("reports a rule enabled by the strictness mode as active", () => {
    const state = resolveRule("scope.allowed-files", policy(), [], { at });
    expect(state.active).toBe(true);
  });

  it("respects an explicit off decision in policy.json", () => {
    const state = resolveRule(
      "scope.allowed-files",
      policy({ rules: { "scope.allowed-files": false } }),
      [],
      { at },
    );
    expect(state.active).toBe(false);
    if (state.active) return;
    expect(state.reason).toBe("disabled");
  });

  it("respects an explicit on decision above the mode default", () => {
    const state = resolveRule(
      "evidence.test-signal",
      policy({ strictness: "relaxed", rules: { "evidence.test-signal": true } }),
      [],
      { at },
    );
    expect(state.active).toBe(true);
  });

  it("waives an overridable rule with a live project-wide override", () => {
    const state = resolveRule("scope.allowed-files", policy(), [override()], { at });
    expect(state.active).toBe(false);
    if (state.active) return;
    expect(state.reason).toBe("overridden");
  });

  it("ignores an override for a rule that cannot be overridden", () => {
    const waiver = override({ rule: "scope.forbidden-paths" });
    const state = resolveRule("scope.forbidden-paths", policy(), [waiver], { at });
    expect(state.active).toBe(true);
  });

  it("cannot waive a review where every acceptance criterion stayed unchecked", () => {
    const waiver = override({ rule: "evidence.criteria-checked" });
    const state = resolveRule("evidence.criteria-checked", policy(), [waiver], { at });
    expect(state.active).toBe(true);
  });

  it("cannot waive executable evidence required before structured implementation", () => {
    const waiver = override({ rule: "contract.executable-evidence" });
    const state = resolveRule("contract.executable-evidence", policy(), [waiver], { at });
    expect(state.active).toBe(true);
  });

  it("ignores an expired override", () => {
    const waiver = override({ expiresAt: "2026-02-01T00:00:00.000Z" });
    expect(resolveRule("scope.allowed-files", policy(), [waiver], { at }).active).toBe(true);
  });

  it("ignores a revoked override", () => {
    const waiver = override({ revokedAt: "2026-03-01T00:00:00.000Z" });
    expect(resolveRule("scope.allowed-files", policy(), [waiver], { at }).active).toBe(true);
  });

  /**
   * `locked` is strict with the escape hatch welded shut. Until this existed
   * the two tiers were byte-identical — a four-position control with three
   * behaviours.
   */
  it("locked refuses even a live, in-scope override", () => {
    const state = resolveRule(
      "scope.allowed-files",
      policy({ strictness: "locked" }),
      [override()],
      { at },
    );
    expect(state.active).toBe(true);
  });

  it("strict still honours the same override", () => {
    const state = resolveRule(
      "scope.allowed-files",
      policy({ strictness: "strict" }),
      [override()],
      { at },
    );
    expect(state.active).toBe(false);
  });
});

describe("override scoping", () => {
  it("applies a feature-scoped override only inside that feature", () => {
    const waiver = override({ scope: { feature: "001-login" } });

    const inside = resolveRule("scope.allowed-files", policy(), [waiver], {
      feature: "001-login",
      at,
    });
    const outside = resolveRule("scope.allowed-files", policy(), [waiver], {
      feature: "002-billing",
      at,
    });

    expect(inside.active).toBe(false);
    expect(outside.active).toBe(true);
  });

  it("requires every named scope field to match", () => {
    const waiver = override({ scope: { feature: "001-login", task: "T001" } });

    const matching = resolveRule("scope.allowed-files", policy(), [waiver], {
      feature: "001-login",
      task: "T001",
      at,
    });
    const wrongTask = resolveRule("scope.allowed-files", policy(), [waiver], {
      feature: "001-login",
      task: "T002",
      at,
    });

    expect(matching.active).toBe(false);
    expect(wrongTask.active).toBe(true);
  });
});

describe("resolveStage and activeRules", () => {
  it("returns the rules a stage evaluates", () => {
    const states = resolveStage("review", policy({ strictness: "strict" }), [], { at });
    const ids = states.map((state) => state.rule.id);
    expect(ids).toContain("evidence.verify-passed");
    expect(ids).toContain("evidence.test-signal");
  });

  it("lists fewer active rules in relaxed than in strict mode", () => {
    const relaxed = activeRules(policy({ strictness: "relaxed" }), [], { at });
    const strict = activeRules(policy({ strictness: "strict" }), [], { at });
    expect(relaxed.length).toBeLessThan(strict.length);
  });
});
