import { describe, expect, it } from "vitest";
import { observationLogSchema } from "../../../../src/workflow/artifacts/observations.js";

describe("observationLogSchema", () => {
  it("fills additive collection defaults for an older minimal record", () => {
    const parsed = observationLogSchema.parse({
      kind: "observations",
      createdAt: "2026-01-01T00:00:00.000Z",
      feature: "001-observe",
      task: "T001",
    });

    expect(parsed.observations).toEqual([]);
  });

  it("accepts legacy receipts without a semantic subject hash", () => {
    const parsed = observationLogSchema.parse({
      kind: "observations",
      createdAt: "2026-01-01T00:00:00.000Z",
      feature: "001-observe",
      task: "T001",
      observations: [
        {
          kind: "observation",
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "OBS-aaaaaaaaaaaa",
          feature: "001-observe",
          task: "T001",
          requirement: "REQ001",
          criterion: "AC001",
          criterionStatement: "The result is visible",
          source: "manual",
          result: "satisfied",
          note: "The result was visible.",
          steps: [],
          specHash: "a".repeat(64),
          contextManifestHash: "b".repeat(64),
          attachments: [],
        },
      ],
    });

    expect(parsed.observations[0]?.subjectHash).toBeUndefined();
  });

  it("keeps the artifact strict", () => {
    expect(() =>
      observationLogSchema.parse({
        kind: "observations",
        createdAt: "2026-01-01T00:00:00.000Z",
        feature: "001-observe",
        task: "T001",
        observations: [],
        trusted: true,
      }),
    ).toThrow();
  });
});
