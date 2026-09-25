import { describe, expect, it } from "vitest";
import {
  acceptanceCriterionSchema,
  intentSchema,
  qualityRequirementSchema,
} from "../../../../src/workflow/artifacts/feature.js";

describe("intent artifact compatibility", () => {
  it("still parses a legacy intent without source-brief provenance", () => {
    const intent = intentSchema.parse({
      kind: "intent",
      createdAt: "2026-08-28T00:00:00.000Z",
      id: "001-login",
      goal: "Add login",
      riskLevel: "low",
    });

    expect(intent.sourceBrief).toBeUndefined();
    expect(intent.sourceBriefHash).toBeUndefined();
  });
});

describe("experience contract vocabulary", () => {
  it.each(["usability", "visual"] as const)("accepts the %s quality category", (category) => {
    const requirement = qualityRequirementSchema.parse({
      id: "NFR001",
      category,
      statement: "The visible result reflects the requested experience",
      target: "A reviewer can compare the rendered result with the source brief",
      priority: "should",
      criteria: [],
    });

    expect(requirement.category).toBe(category);
  });

  it("marks visual observation separately from executable verification", () => {
    const criterion = acceptanceCriterionSchema.parse({
      id: "AC001",
      statement: "The primary action remains visually prominent",
      verificationKind: "inspection",
      verification: "inspection: compare the rendered output with the source brief",
      observationKind: "visual",
    });

    expect(criterion.observationKind).toBe("visual");
    expect(criterion.verificationKind).toBe("inspection");
  });
});
