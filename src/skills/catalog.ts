import type { Stage } from "../core/constants.js";
import { EDGE_CASES_FIRST_CONTENT } from "./catalog/edge-cases-first.js";
import { RESEARCH_THE_CRAFT_CONTENT } from "./catalog/research-the-craft.js";
import { fingerprint } from "./store.js";

export interface SkillCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly stages: readonly Stage[];
  readonly contentHash: string;
}

export interface BundledSkill {
  readonly summary: SkillCatalogEntry;
  readonly content: string;
}

const RESEARCH_THE_CRAFT: BundledSkill = {
  summary: {
    id: "research-the-craft",
    version: "3.7.0",
    description:
      "Investigate load-bearing uncertainty before it becomes a design, implementation, or testing mistake. Start with repository evidence and search externally only for unresolved or version-sensitive facts.",
    stages: ["context", "implement"],
    contentHash: fingerprint(RESEARCH_THE_CRAFT_CONTENT),
  },
  content: RESEARCH_THE_CRAFT_CONTENT,
};

const EDGE_CASES_FIRST: BundledSkill = {
  summary: {
    id: "edge-cases-first",
    version: "1.0.0",
    description:
      "Pin current behavior and the request's edge cases as tests before changing code, so a change or fix does not break nearby behavior.",
    stages: ["implement"],
    contentHash: fingerprint(EDGE_CASES_FIRST_CONTENT),
  },
  content: EDGE_CASES_FIRST_CONTENT,
};

const BUNDLED_SKILLS: readonly BundledSkill[] = [EDGE_CASES_FIRST, RESEARCH_THE_CRAFT];

/** Public metadata intentionally excludes the body; `seed` is the copy boundary. */
export function skillCatalog(): readonly SkillCatalogEntry[] {
  return BUNDLED_SKILLS.map((skill) => ({
    ...skill.summary,
    stages: [...skill.summary.stages],
  }));
}

export function bundledSkill(id: string): BundledSkill | undefined {
  return BUNDLED_SKILLS.find((skill) => skill.summary.id === id);
}
