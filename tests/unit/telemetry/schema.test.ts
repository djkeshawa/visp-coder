import { describe, expect, it } from "vitest";
import { type UsageReceipt, usageReceiptSchema } from "../../../src/telemetry/schema.js";

function receipt(): UsageReceipt {
  return {
    source: "codex",
    runId: "run",
    sourceFile: "session.jsonl",
    sourceFileHash: "a".repeat(64),
    projectRoot: "/project",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:00:10.000Z",
    importedAt: "2026-09-01T00:00:11.000Z",
    inputTokens: 10,
    cachedInputTokens: 5,
    outputTokens: 10,
    reasoningTokens: 5,
    segments: [
      {
        at: "2026-09-01T00:00:04.000Z",
        inputTokens: 5,
        cachedInputTokens: 5,
        outputTokens: 5,
        reasoningTokens: 5,
      },
      {
        at: "2026-09-01T00:00:05.000Z",
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
    ],
  };
}
describe("attributable usage receipts", () => {
  it("accepts reconciled segments", () => {
    expect(usageReceiptSchema.safeParse(receipt()).success).toBe(true);
  });
  it("rejects segment subtotals even when cumulative totals reconcile", () => {
    const value = receipt();
    if (!value.segments?.[0] || !value.segments[1]) throw new Error("fixture");
    value.segments[0] = { ...value.segments[0], inputTokens: 4 };
    value.segments[1] = { ...value.segments[1], inputTokens: 6 };
    expect(usageReceiptSchema.safeParse(value).success).toBe(false);
  });
  it.each(["2026-08-31T23:59:59.000Z", "2026-09-01T00:00:11.000Z", "2026-09-01T00:00:06.000Z"])(
    "rejects out-of-order or out-of-run segments at %s",
    (at) => {
      const value = receipt();
      if (!value.segments?.[0]) throw new Error("fixture");
      value.segments[0] = { ...value.segments[0], at };
      expect(usageReceiptSchema.safeParse(value).success).toBe(false);
    },
  );
  it("rejects unsafe integer counts", () => {
    expect(
      usageReceiptSchema.safeParse({
        ...receipt(),
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        segments: undefined,
      }).success,
    ).toBe(false);
  });
});
