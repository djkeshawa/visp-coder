import { expect, it } from "vitest";
import { browserCheckSummary } from "../../../../src/workflow/product/browser-check-execution.js";

it("puts a bounded failure ahead of capture IDs", () => {
  const summary = JSON.parse(
    browserCheckSummary({
      status: "failed",
      runId: "RUN-1",
      operations: 20,
      nextCommand: "visp next",
      failure: { kind: "behavior", message: "Second action failed", actionIndex: 1 },
      captures: Array.from({ length: 6 }, (_, index) => ({ id: `CAP-${index}` })),
    } as Parameters<typeof browserCheckSummary>[0]),
  );
  expect(summary).toMatchObject({
    status: "failed",
    failure: { kind: "behavior", message: "Second action failed", actionIndex: 1 },
    runId: "RUN-1",
  });
  expect(summary.captures).toEqual(["CAP-0", "CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5"]);
});
