import { describe, expect, it } from "vitest";
import { parseTestReport } from "../../../../src/runner/reports.js";
import { runValidationCommands } from "../../../../src/workflow/evidence/commands.js";

function report(
  results: string[][],
  stats: Record<"expected" | "unexpected" | "flaky" | "skipped", number>,
) {
  return {
    config: {},
    errors: [],
    stats: { startTime: "2026-09-06", duration: 1, ...stats },
    suites: [
      {
        specs: results.map((attempts, index) => ({
          id: `document-${index}`,
          tests: [
            {
              projectName: "browser",
              status: attempts.length > 1 ? "flaky" : "expected",
              results: attempts.map((status) => ({ status })),
            },
          ],
        })),
      },
    ],
  };
}

const clean = report([["passed"]], { expected: 1, unexpected: 0, flaky: 0, skipped: 0 });
const skipped = report([["skipped"]], { expected: 0, unexpected: 0, flaky: 0, skipped: 1 });
const badCases = [
  ["invented aggregate pass", { ...clean, suites: [] }],
  ["absent execution results", report([[]], clean.stats)],
  ["failed case with green aggregate", report([["failed"]], clean.stats)],
  ["duplicate case identities", { ...clean, suites: [...clean.suites, ...clean.suites] }],
  [
    "flaky final pass",
    report([["failed", "passed"]], { expected: 0, unexpected: 0, flaky: 1, skipped: 0 }),
  ],
  ["all cases skipped", skipped],
  ["runner error", { ...clean, errors: [{ message: "Browser unavailable" }] }],
  ["contradictory failure count", { ...clean, stats: { ...clean.stats, unexpected: 1 } }],
] as const;

async function execute(value: unknown) {
  return runValidationCommands(
    [[process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify(value))})`]],
    process.cwd(),
  );
}

describe("workflow and independent evaluation agree on reported execution", () => {
  it.each(badCases)("does not accept %s", async (_name, value) => {
    let independentAccepted = false;
    let invalid = false;
    try {
      independentAccepted = parseTestReport("playwright", value).successful;
    } catch {
      invalid = true;
    }
    expect(independentAccepted).toBe(false);
    const result = await execute(value);
    expect(result.passed).toBe(false);
    if (invalid) {
      expect(result.results[0]?.failureKind).toBe("invalid-report");
      expect(result.results[0]?.testSummary).toBeUndefined();
    }
  });

  it.each([
    [
      "vitest",
      {
        testResults: [
          {
            name: "documents.test.ts",
            assertionResults: [{ fullName: "saves document", status: "passed" }],
          },
        ],
        numPassedTests: 1,
      },
    ],
    [
      "pytest",
      {
        exitcode: 0,
        tests: [
          { nodeid: "documents.py::test_save", outcome: "passed", call: { outcome: "passed" } },
        ],
        summary: { passed: 1 },
      },
    ],
  ] as const)("shares valid and contradictory %s JSON handling", async (format, value) => {
    expect(parseTestReport(format, value).successful).toBe(true);
    expect((await execute(value)).passed).toBe(true);
    const contradictory =
      format === "vitest" ? { ...value, numPassedTests: 2 } : { ...value, summary: { passed: 2 } };
    expect(() => parseTestReport(format, contradictory)).toThrow(/counter/);
    expect((await execute(contradictory)).results[0]?.failureKind).toBe("invalid-report");
  });

  it("accepts a valid executed case through both paths", async () => {
    expect(parseTestReport("playwright", clean)).toMatchObject({ passed: 1, successful: true });
    expect(await execute(clean)).toMatchObject({
      passed: true,
      results: [{ testSummary: { passed: 1, failed: 0, skipped: 0 } }],
    });
  });

  it("accepts a test that correctly exercises an expected failure", async () => {
    const value = report([["failed"]], { expected: 1, unexpected: 0, flaky: 0, skipped: 0 });
    const test = value.suites[0]?.specs[0]?.tests[0];
    if (!test) throw Error("Missing fixture case");
    Object.assign(test, { expectedStatus: "failed", status: "expected" });
    expect(parseTestReport("playwright", value)).toMatchObject({ passed: 1, successful: true });
    expect((await execute(value)).passed).toBe(true);
  });

  it("retains skipped cases that were never scheduled, without treating them as passes", async () => {
    const value = report([["passed"], []], { expected: 1, unexpected: 0, flaky: 0, skipped: 1 });
    const test = value.suites[0]?.specs[1]?.tests[0];
    if (!test) throw Error("Missing fixture case");
    test.status = "skipped";
    expect(parseTestReport("playwright", value)).toMatchObject({ passed: 1, skipped: 1 });
    expect((await execute(value)).results[0]?.testSummary).toMatchObject({ passed: 1, skipped: 1 });
  });
});
