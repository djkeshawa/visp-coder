import { describe, expect, it } from "vitest";
import { executionSummary } from "../../../src/ui/views.js";
import type { ProductExecution } from "../../../src/workflow/product/model.js";

const run = (check: string, status: ProductExecution["status"]) =>
  ({
    id: `${check}-run`,
    check,
    task: "T001",
    createdAt: "2026-10-10T10:00:00.000Z",
    command: "node test.mjs",
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 1200,
    provenance: "supervisor-executed",
    assertions: "runner-observed",
    output: "FAIL: level 2 can be won\n",
  }) as unknown as ProductExecution;

describe("executionSummary", () => {
  it("marks a pinned acceptance suite's run as the independent tester's", () => {
    expect(executionSummary(run("PINNED_1", "failed"), true).source).toBe("tester");
    expect(executionSummary(run("C001", "failed"), true).source).toBe("agent");
  });

  it("keeps a timed-out run as its own status", () => {
    const summary = executionSummary(run("C001", "timed-out"), false);
    expect(summary).toMatchObject({ status: "timed-out", current: false });
  });
});
