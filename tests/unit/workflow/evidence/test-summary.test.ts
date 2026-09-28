import { describe, expect, it } from "vitest";
import {
  nodeTestSummary,
  runnerTestSummary,
} from "../../../../src/workflow/evidence/test-summary.js";

const tap = (total: number, passed: number, failed: number, skipped: number, todo = 0) =>
  `TAP version 13\n1..${total}\n# tests ${total}\n# suites 0\n# pass ${passed}\n# fail ${failed}\n# cancelled 0\n# skipped ${skipped}\n# todo ${todo}\n# duration_ms 10.404\n`;

describe("Node TAP summary", () => {
  it("reads a complete summary, including TODO coverage", () => {
    expect(nodeTestSummary(tap(4, 1, 1, 1, 1))).toEqual({ passed: 1, failed: 1, skipped: 2 });
  });
  it("does not infer skipped coverage from prose or an incomplete footer", () => {
    expect(nodeTestSummary("Tests passed; skipped 3 optional checks")).toBeUndefined();
    expect(nodeTestSummary("TAP version 13\n# pass 0\n# skipped 3")).toBeUndefined();
  });
  it("does not accept inconsistent or nested counters as a runner summary", () => {
    expect(nodeTestSummary(tap(8, 1, 0, 1))).toBeUndefined();
    expect(nodeTestSummary(tap(2, 1, 0, 1).replaceAll("\n#", "\n    #"))).toBeUndefined();
  });
  it("preserves zero-test results and accepts Windows line endings", () => {
    expect(nodeTestSummary(tap(0, 0, 0, 0).replaceAll("\n", "\r\n"))).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe("browser runner summaries", () => {
  const report = {
    config: {},
    suites: [
      {
        specs: ["passed", "passed", "failed", "flaky", "skipped", "skipped", "skipped"].map(
          (status, index) => ({
            id: `document-${index}`,
            tests: [
              {
                projectName: "browser",
                status: status === "flaky" ? "flaky" : "expected",
                results: (status === "flaky" ? ["failed", "passed"] : [status]).map((status) => ({
                  status,
                })),
              },
            ],
          }),
        ),
      },
    ],
    errors: [],
    stats: {
      startTime: "2026-09-06",
      duration: 1,
      expected: 2,
      unexpected: 1,
      flaky: 1,
      skipped: 3,
    },
  };
  it("retains passing, failing, retried and skipped outcomes", () => {
    expect(runnerTestSummary(JSON.stringify(report))).toEqual({
      passed: 3,
      failed: 1,
      skipped: 3,
      flaky: 1,
    });
    expect(
      runnerTestSummary(
        JSON.stringify({ ...report, errors: [{ message: "Browser unavailable" }] }),
      ),
    ).toEqual({ passed: 3, failed: 1, skipped: 3, flaky: 1, errors: 1 });
  });
  it("does not infer counters from prose, partial reports or invalid counts", () => {
    for (const output of [
      "2 passed",
      JSON.stringify(report.stats),
      JSON.stringify(report).slice(0, -1),
    ]) {
      expect(runnerTestSummary(output)).toBeUndefined();
    }
    expect(() =>
      runnerTestSummary(JSON.stringify({ ...report, stats: { ...report.stats, expected: -1 } })),
    ).toThrow();
  });
});

describe("Node spec summary", () => {
  const spec =
    "✔ works (1ms)\nℹ tests 4\nℹ suites 0\nℹ pass 1\nℹ fail 1\nℹ cancelled 1\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 10.404\n";
  it("reads a complete spec footer, including color and Windows line endings", () => {
    expect(runnerTestSummary(spec)).toEqual({ passed: 1, failed: 2, skipped: 1 });
    expect(runnerTestSummary(`\u001b[32m${spec.replaceAll("\n", "\r\n")}\u001b[39m`)).toEqual({
      passed: 1,
      failed: 2,
      skipped: 1,
    });
  });
  it("rejects incomplete, inconsistent and nested spec counters", () => {
    for (const text of [
      spec.replace("ℹ tests 4", "ℹ tests 8"),
      spec.replaceAll("ℹ", "  ℹ"),
      "ℹ pass 1\nℹ fail 0",
    ]) {
      expect(runnerTestSummary(text)).toBeUndefined();
    }
  });
});
