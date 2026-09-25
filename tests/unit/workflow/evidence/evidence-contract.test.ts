import { describe, expect, it } from "vitest";
import { evidenceContractSchema } from "../../../../src/workflow/artifacts/evidence-contract.js";
import { parseEvidenceReceipts } from "../../../../src/workflow/evidence/contract-receipts.js";

const contract = {
  surface: "canvas" as const,
  checkpoints: [
    {
      id: "held",
      phase: "during" as const,
      expectation: "The rendered object follows the pointer",
    },
  ],
  negativeControls: [
    { id: "no-render", expectation: "Disabling drawing makes the same check fail" },
  ],
};
const checkpoint = {
  criterion: "AC001",
  kind: "checkpoint",
  id: "held",
  surface: "canvas",
  outcome: "passed",
  samples: 3,
};
const sensitivity = {
  criterion: "AC001",
  kind: "negative-control",
  id: "no-render",
  surface: "canvas",
  outcome: "passed",
  baselinePassed: true,
  changedPassed: false,
};
const line = (value: unknown) => `# VISP_EVIDENCE ${JSON.stringify(value)}`;

describe("explicit evidence contracts", () => {
  it("parses printed receipts and rejects malformed or inconclusive ones", () => {
    expect(
      parseEvidenceReceipts([line(checkpoint), "ordinary output", line(sensitivity)].join("\n")),
    ).toHaveLength(2);
    expect(() => parseEvidenceReceipts("VISP_EVIDENCE {broken}")).toThrow();
    expect(() => parseEvidenceReceipts(line({ ...sensitivity, changedPassed: true }))).toThrow();
  });
  it("validates bounded, unique contracts and rejects unknown fields", () => {
    expect(evidenceContractSchema.safeParse(contract).success).toBe(true);
    expect(
      evidenceContractSchema.safeParse({
        ...contract,
        checkpoints: [contract.checkpoints[0], contract.checkpoints[0]],
      }).success,
    ).toBe(false);
    expect(evidenceContractSchema.safeParse({ ...contract, surface: "trust-me" }).success).toBe(
      false,
    );
    expect(evidenceContractSchema.safeParse({ ...contract, checkpoints: [] }).success).toBe(false);
  });
});
