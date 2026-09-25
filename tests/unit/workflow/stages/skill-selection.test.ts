import { describe, expect, it } from "vitest";
import type { ApplicationFacts } from "../../../../src/skills/applies.js";
import { rankSkills } from "../../../../src/skills/rank.js";
import {
  type SkillAppliesTo,
  type SkillRecord,
  skillRecordSchema,
} from "../../../../src/skills/schema.js";

/**
 * The trigger is the safety property, not decoration: an uncurated library
 * measurably degrades a strong model, so these are written as attempts to get a
 * skill in front of an agent that nobody chose to put there.
 */

/** Takes a partial `appliesTo`, since the schema fills the dimensions nobody named. */
type SkillOverrides = Partial<Omit<SkillRecord, "appliesTo">> & {
  appliesTo?: Partial<SkillAppliesTo>;
};

function skill(overrides: SkillOverrides = {}): SkillRecord {
  return skillRecordSchema.parse({
    id: "regenerate-client",
    name: "Regenerate the client",
    state: "admitted",
    trust: "advisory",
    contentHash: "0123456789ab",
    createdAt: "2026-01-01T00:00:00.000Z",
    appliesTo: { paths: ["src/auth/**"] },
    ...overrides,
  });
}

const facts: ApplicationFacts = {
  stages: ["context", "implement"],
  taskClass: "feature",
  scopePaths: ["src/auth/login.ts"],
};

function chosen(skills: readonly SkillRecord[], take = 3): string[] {
  return rankSkills({ skills, facts })
    .map((candidate) => candidate.skill.id)
    .slice(0, take);
}

describe("rankSkills", () => {
  it("takes an admitted skill whose trigger fires", () => {
    expect(chosen([skill()])).toEqual(["regenerate-client"]);
  });

  it("leaves out one whose trigger does not fire", () => {
    expect(chosen([skill({ appliesTo: { paths: ["src/billing/**"] } })])).toEqual([]);
  });

  /**
   * Eligibility is an allow-list. `proposed` is something nobody has looked at,
   * and every other state is a decision that it should not be in front of an
   * agent — including `orphaned`, where the work it was drawn from is gone.
   */
  it.each(["proposed", "rejected", "retired", "orphaned"] as const)(
    "leaves out a %s skill however well it matches",
    (state) => {
      expect(chosen([skill({ state })])).toEqual([]);
    },
  );

  /**
   * Ranking is uncapped on purpose: the caller takes from the front until the
   * pack is full, so a skill that turns out to be unusable gives its place back
   * rather than shrinking the pack.
   */
  it("ranks every match, leaving the cap to the caller", () => {
    const many = ["a-skill", "b-skill", "c-skill", "d-skill", "e-skill"].map((id) => skill({ id }));
    expect(rankSkills({ skills: many, facts })).toHaveLength(5);
  });

  it("prefers the more specifically targeted skill when the cap bites", () => {
    const broad = skill({ id: "broad-skill", appliesTo: { stage: ["implement"] } });
    const narrow = skill({
      id: "narrow-skill",
      appliesTo: { paths: ["src/auth/**"], taskClass: ["feature"], stage: ["implement"] },
    });

    expect(chosen([broad, narrow], 1)).toEqual(["narrow-skill"]);
  });

  it("does not treat a declared verification label as evidence of usefulness", () => {
    const advisory = skill({ id: "a-skill", trust: "advisory" });
    const verified = skill({ id: "z-skill", trust: "declared" });

    expect(chosen([advisory, verified], 1)).toEqual(["a-skill"]);
  });

  it("falls back to the id so the same library gives the same pack", () => {
    const first = skill({ id: "b-skill" });
    const second = skill({ id: "a-skill" });

    expect(chosen([first, second], 1)).toEqual(["a-skill"]);
    expect(chosen([second, first], 1)).toEqual(["a-skill"]);
  });

  /** A seeded skill has no closed work behind it and is selected all the same. */
  it("does not care which origin a skill has", () => {
    expect(chosen([skill({ origin: "seeded", derivedFrom: [] })])).toEqual(["regenerate-client"]);
  });
});
