import { describe, expect, it } from "vitest";
import { verificationCommand } from "../../../src/skills/admit.js";
import {
  BUNDLED_SKILL_BASE_HASHES,
  bundledSkill,
  skillCatalog,
} from "../../../src/skills/catalog.js";
import { readAppliesTo } from "../../../src/skills/schema.js";
import { fingerprint, parseSkill, skillDescription } from "../../../src/skills/store.js";

describe("bundled skill catalog", () => {
  it("publishes stable metadata without exposing the bundled body", () => {
    const catalog = skillCatalog();

    expect(catalog).toEqual([
      {
        id: "research-the-craft",
        version: "3.7.0",
        description:
          "Investigate load-bearing uncertainty before it becomes a design, implementation, or testing mistake. Start with repository evidence and search externally only for unresolved or version-sensitive facts.",
        stages: ["context", "implement"],
        contentHash: expect.stringMatching(/^[a-f0-9]{12}$/),
      },
    ]);
    expect(catalog[0]).not.toHaveProperty("content");
  });

  it("keeps catalog metadata aligned with the bundled SKILL.md", () => {
    const skill = bundledSkill("research-the-craft");
    expect(skill).toBeDefined();
    if (!skill) return;

    const document = parseSkill(skill.content);
    expect(document.ok).toBe(true);
    if (!document.ok) return;

    const appliesTo = readAppliesTo(document.value.frontmatter);
    expect(appliesTo.ok).toBe(true);
    if (!appliesTo.ok) return;

    expect(skill.summary.description).toBe(skillDescription(document.value));
    expect(skill.summary.stages).toEqual(appliesTo.value?.stage);
    expect(skill.summary.contentHash).toBe(fingerprint(skill.content));
    expect(BUNDLED_SKILL_BASE_HASHES[skill.summary.id]).toBe(
      "e791ca95d33ecb23d8ea27cac3f1cd978e93441b33d83af034fd9a98d786a48f",
    );
  });

  it("investigates load-bearing uncertainty instead of imitating references", () => {
    const content = bundledSkill("research-the-craft")?.content ?? "";

    expect(content).toContain("uncertainty-driven investigation");
    expect(content).toContain("greenfield/domain");
    expect(content).toContain("brownfield/repository");
    expect(content).toContain("stack/API");
    expect(content).toContain("algorithm/logic");
    expect(content).toContain("**UX**");
    expect(content).toContain("failure investigation");
    expect(content).toContain("repository-first is mandatory");
    expect(content).toContain(
      "Use external search only for unresolved or version-sensitive questions.",
    );
    expect(content).not.toContain("Find at least three real reference implementations.");
    expect(content).not.toContain("Not during implementation");
    expect(content).toContain("Translate research into engineering structure");
    expect(content).toContain("state owner");
    expect(content).toContain("integration checks exercise module contracts");
    expect(content).toContain("Playwright");
    expect(content).toContain("Do not optimize for the number of generated tests.");
    expect(content).toContain("missing file or export establishes dependency");
    expect(content).toContain("one still image cannot establish motion");
    expect(content).toContain("observable result that would falsify");
    expect(content).toContain("performance bound cannot establish behavioral correctness");
    expect(content).toContain("seed or freeze randomness");
    expect(content).toContain("fresh scenario state");
    expect(content).toContain("wait for an observable stable state");
  });

  it("keeps receipts compact, routes findings, and remains advisory", () => {
    const content = bundledSkill("research-the-craft")?.content ?? "";

    expect(content).toContain("Write compact evidence receipts");
    expect(content).toMatch(
      /\*\*outcomes\*\*[\s\S]*\*\*decisions\*\*[\s\S]*\*\*tests\*\*[\s\S]*\*\*uncertainties\*\*/,
    );
    expect(content).toContain("current product brief");
    expect(content).not.toContain("`research.json`");
    expect(content).not.toContain("normal entry point is the `research` stage");
    expect(content).toContain("`visp learn`");
    expect(content).toContain("generalized skill");
    expect(content).toContain("Three reference products are not a default requirement.");
    expect(content).toContain("This skill is advisory.");
    expect(verificationCommand(content)).toBeUndefined();
  });

  it("investigates delivery constraints without treating an artifact as source architecture", () => {
    const content = bundledSkill("research-the-craft")?.content ?? "";

    expect(content).toContain("self-contained artifact");
    expect(content).toContain("one authored file/no build");
    expect(content).toContain("existing plan decisions");
    expect(content).toContain("do not compact");
    expect(content).toContain("This skill is advisory.");
  });
});
