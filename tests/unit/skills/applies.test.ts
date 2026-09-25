import { describe, expect, it } from "vitest";
import { ENTRYPOINT_KINDS } from "../../../src/graph/types.js";
import {
  type ApplicationFacts,
  applicationOf,
  couldFireAnywhere,
  SELECTING_STAGES,
} from "../../../src/skills/applies.js";
import {
  readAppliesTo,
  SKILL_ENTRYPOINT_KINDS,
  type SkillAppliesTo,
  skillAppliesToSchema,
} from "../../../src/skills/schema.js";

/**
 * A trigger decides what an agent is told, so these are written as attempts to
 * make a skill fire somewhere its author never said it belonged.
 */

function trigger(declared: Partial<SkillAppliesTo> = {}): SkillAppliesTo {
  return skillAppliesToSchema.parse(declared);
}

function facts(overrides: Partial<ApplicationFacts> = {}): ApplicationFacts {
  return {
    stages: ["context", "implement"],
    taskClass: "feature",
    scopePaths: ["src/auth/**", "src/auth/login.ts"],
    entrypointKinds: ["http_route"],
    languages: ["typescript"],
    ...overrides,
  };
}

describe("applicationOf", () => {
  it("fires when the one dimension it declares holds", () => {
    expect(applicationOf(trigger({ paths: ["src/auth/**"] }), facts()).applies).toBe(true);
  });

  it("does not fire when the paths it names cover nothing in scope", () => {
    expect(applicationOf(trigger({ paths: ["src/billing/**"] }), facts()).applies).toBe(false);
  });

  /**
   * The skill's globs must cover a scope entry, not the reverse. A task scoped
   * to all of `src/**` is not thereby a task about auth.
   */
  it("does not fire on a task whose scope merely contains its paths", () => {
    const application = applicationOf(
      trigger({ paths: ["src/auth/**"] }),
      facts({ scopePaths: ["src/**"] }),
    );

    expect(application.applies).toBe(false);
  });

  it("requires every dimension it declares, not any of them", () => {
    const application = applicationOf(
      trigger({ paths: ["src/auth/**"], taskClass: ["docs"] }),
      facts(),
    );

    expect(application.applies).toBe(false);
  });

  it("accepts any of the values inside one dimension", () => {
    const application = applicationOf(trigger({ taskClass: ["docs", "feature"] }), facts());

    expect(application.applies).toBe(true);
  });

  /** Silence is not consent: an author who said nothing chose nothing. */
  it("applies nowhere when there is no trigger at all", () => {
    expect(applicationOf(undefined, facts()).applies).toBe(false);
  });

  it("applies nowhere when the trigger names no dimension", () => {
    expect(applicationOf(trigger(), facts()).applies).toBe(false);
  });

  describe("stage", () => {
    it("fires on a stage the pack serves", () => {
      expect(applicationOf(trigger({ stage: ["implement"] }), facts()).applies).toBe(true);
    });

    it("does not fire on a stage it was not written for", () => {
      expect(applicationOf(trigger({ stage: ["pr"] }), facts()).applies).toBe(false);
    });

    /** The point of `stage`: seeded knowledge that lands before any task exists. */
    it("still evaluates when there is no task", () => {
      const application = applicationOf(trigger({ stage: ["spec"] }), { stages: ["spec"] });

      expect(application.applies).toBe(true);
    });

    it("cannot match a task class when there is no task", () => {
      const application = applicationOf(trigger({ taskClass: ["feature"] }), { stages: ["spec"] });

      expect(application.applies).toBe(false);
    });
  });

  /**
   * A dimension nobody could answer must not be waved through. There is no
   * index in a fresh clone, so these facts are absent rather than empty by
   * coincidence, and firing anyway would report a check that never ran.
   */
  describe("facts the caller cannot supply", () => {
    it("does not fire on an entrypoint kind when there is no index", () => {
      const application = applicationOf(trigger({ entrypointKind: ["http_route"] }), {
        stages: ["context"],
        taskClass: "feature",
        scopePaths: ["src/auth/**"],
      });

      expect(application.applies).toBe(false);
    });

    it("does not fire on a language when there is no index", () => {
      const application = applicationOf(trigger({ language: ["typescript"] }), {
        stages: ["context"],
      });

      expect(application.applies).toBe(false);
    });

    it("fires on an entrypoint kind the index actually found", () => {
      expect(applicationOf(trigger({ entrypointKind: ["http_route"] }), facts()).applies).toBe(
        true,
      );
    });

    it("does not fire on an entrypoint kind the index did not find", () => {
      expect(applicationOf(trigger({ entrypointKind: ["cli_command"] }), facts()).applies).toBe(
        false,
      );
    });
  });

  it("reports which dimensions it matched, so specificity is checkable", () => {
    const application = applicationOf(
      trigger({ paths: ["src/auth/**"], taskClass: ["feature"], stage: ["implement"] }),
      facts(),
    );

    expect(application.matched).toEqual(["paths", "taskClass", "stage"]);
  });

  it("is the same answer for the same facts", () => {
    const declared = trigger({ paths: ["src/auth/**"], language: ["typescript"] });
    expect(applicationOf(declared, facts())).toEqual(applicationOf(declared, facts()));
  });
});

/**
 * A trigger that cannot fire anywhere is indistinguishable from one that has
 * simply not matched yet, so the difference has to be reportable.
 */
describe("couldFireAnywhere", () => {
  it("is true for a trigger naming a dimension", () => {
    expect(couldFireAnywhere(trigger({ paths: ["src/**"] }))).toBe(true);
  });

  it("is false with no trigger at all", () => {
    expect(couldFireAnywhere(undefined)).toBe(false);
  });

  it("is false for a trigger naming no dimension", () => {
    expect(couldFireAnywhere(trigger())).toBe(false);
  });

  /** The stage is accepted so the knowledge can be written down; nothing
   * assembles material there, and pretending otherwise would be a claim. */
  it("is false when it names only stages nothing selects at", () => {
    expect(couldFireAnywhere(trigger({ paths: ["src/**"], stage: ["pr", "review"] }))).toBe(false);
  });

  /** The point of the drafting stages selecting: a seeded spec-time skill is
   * a working trigger now, not a note about a future feature. */
  it("is false for a trigger naming only retired drafting stages", () => {
    expect(couldFireAnywhere(trigger({ stage: ["research", "spec", "plan"] }))).toBe(false);
  });

  it("does not advertise selection for the retired research stage", () => {
    expect(SELECTING_STAGES).not.toContain("research");
    expect(applicationOf(trigger({ stage: ["research"] }), { stages: ["research"] }).applies).toBe(
      true,
    );
  });

  it("is true when one of the stages it names does select", () => {
    expect(couldFireAnywhere(trigger({ stage: ["pr", "implement"] }))).toBe(true);
  });

  it("agrees with the stages the pack is actually built for", () => {
    for (const stage of SELECTING_STAGES) {
      expect(applicationOf(trigger({ stage: [stage] }), facts({ stages: [stage] })).applies).toBe(
        true,
      );
    }
  });
});

describe("readAppliesTo", () => {
  it("finds nothing when the frontmatter declares nothing", () => {
    const result = readAppliesTo({ name: "x" });
    expect(result.ok && result.value).toBeUndefined();
  });

  it("reads a single value as a one-value dimension", () => {
    const result = readAppliesTo({ appliesTo: { stage: "plan" } });
    expect(result.ok && result.value?.stage).toEqual(["plan"]);
  });

  it("accepts the key however it is spelled", () => {
    const result = readAppliesTo({ applies_to: { stage: ["plan"] } });
    expect(result.ok && result.value?.stage).toEqual(["plan"]);
  });

  /** Dropping it silently would file a skill that can never fire and say nothing. */
  it("refuses a dimension it cannot evaluate", () => {
    const result = readAppliesTo({ appliesTo: { stage: ["whenever"] } });
    expect(result.ok).toBe(false);
  });

  it("refuses a misspelled dimension rather than ignoring it", () => {
    const result = readAppliesTo({ appliesTo: { path: ["src/**"] } });
    expect(result.ok).toBe(false);
  });

  /** A bare YAML key parses as null and is how one says "no constraint". */
  it("reads a dimension left empty as no constraint", () => {
    const result = readAppliesTo({ appliesTo: { paths: ["src/**"], taskClass: null } });

    expect(result.ok && result.value?.taskClass).toEqual([]);
  });
});

/**
 * The list in `skills/` is a copy, kept there so selection does not drag
 * `graph/` into `workflow/`. This is what stops the copy drifting in silence.
 */
describe("SKILL_ENTRYPOINT_KINDS", () => {
  it("names exactly the entrypoint kinds the graph records", () => {
    expect([...SKILL_ENTRYPOINT_KINDS].sort()).toEqual([...ENTRYPOINT_KINDS].sort());
  });
});
