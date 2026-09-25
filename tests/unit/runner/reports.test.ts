import { describe, expect, it } from "vitest";
import { parseTestReport } from "../../../src/runner/reports.js";

describe("independent report normalization", () => {
  it("keeps skipped Vitest tests distinct and detects contradictory counters", () => {
    const report = {
      success: true,
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 1,
      testResults: [
        {
          name: "a.test.ts",
          assertionResults: [
            { fullName: "accepts valid input", status: "passed" },
            { fullName: "rejects invalid input", status: "pending" },
          ],
        },
      ],
    };
    expect(parseTestReport("vitest", report)).toMatchObject({
      passed: 1,
      failed: 0,
      skipped: 1,
      executed: 1,
      successful: true,
    });
    expect(() => parseTestReport("vitest", { ...report, numPassedTests: 2 })).toThrow(/counter/i);
  });

  it("requires pytest execution evidence and rejects collection errors", () => {
    expect(
      parseTestReport("pytest", {
        exitcode: 0,
        summary: { total: 2, passed: 1, skipped: 1 },
        tests: [
          { nodeid: "t.py::test_ok", outcome: "passed", call: { outcome: "passed" } },
          { nodeid: "t.py::test_skip", outcome: "skipped" },
        ],
      }),
    ).toMatchObject({
      passed: 1,
      skipped: 1,
      executed: 1,
      successful: true,
    });
    expect(
      parseTestReport("pytest", { exitcode: 2, summary: { total: 0 }, tests: [] }),
    ).toMatchObject({ successful: false, executed: 0 });
    expect(() =>
      parseTestReport("pytest", {
        exitcode: 0,
        tests: [{ nodeid: "t.py::test_ok", outcome: "passed" }],
      }),
    ).toThrow(/execution/i);
  });

  it("does not hide failed retries behind a final Playwright pass", () => {
    const report = parseTestReport("playwright", {
      errors: [],
      suites: [
        {
          title: "suite",
          specs: [
            {
              id: "test-1",
              title: "checkout",
              tests: [
                {
                  projectName: "chromium",
                  status: "flaky",
                  results: [
                    { status: "failed", retry: 0 },
                    { status: "passed", retry: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(report).toMatchObject({
      passed: 1,
      failed: 0,
      flaky: 1,
      successful: false,
      executed: 1,
    });
    expect(report.tests[0]?.attempts).toEqual(["failed", "passed"]);
  });

  it("rejects duplicate test identities and malformed reporter input", () => {
    expect(() =>
      parseTestReport("vitest", {
        testResults: [
          {
            name: "a",
            assertionResults: [
              { fullName: "same", status: "passed" },
              { fullName: "same", status: "passed" },
            ],
          },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() => parseTestReport("playwright", {})).toThrow(/suites/i);
  });

  it("reads built-in pytest JUnit without evaluating XML entities", () => {
    expect(
      parseTestReport(
        "pytest",
        '<?xml version="1.0"?><testsuites><testsuite tests="2"><testcase classname="test_api" name="ok"/><testcase classname="test_api" name="later"><skipped/></testcase></testsuite></testsuites>',
      ),
    ).toMatchObject({ passed: 1, skipped: 1, executed: 1 });
    expect(() =>
      parseTestReport(
        "pytest",
        '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite><testcase name="&x;"/></testsuite>',
      ),
    ).toThrow(/DTD|entities/i);
    expect(() => parseTestReport("pytest", '<testsuite><testcase name="bad"></testsuite>')).toThrow(
      /mismatched/i,
    );
  });

  it.each([
    'tests="2"',
    'failures="1"',
    'errors="1"',
    'skipped="1"',
    'tests=""',
    'tests="-1"',
    'tests="1.5"',
  ])("rejects inconsistent nested JUnit counters: %s", (counters) => {
    expect(() =>
      parseTestReport(
        "pytest",
        `<testsuites><testsuite ${counters}><testcase name="ok"/></testsuite></testsuites>`,
      ),
    ).toThrow(/counter/i);
  });

  it("checks JUnit counters within each suite and across the report", () => {
    const report = parseTestReport(
      "pytest",
      '<testsuites tests="3" failures="1" errors="0" skipped="1"><testsuite tests="1" failures="0"><testcase name="ok"/></testsuite><testsuite tests="2" failures="1" skipped="1"><testcase name="bad"><failure/></testcase><testcase name="later"><skipped/></testcase></testsuite></testsuites>',
    );
    expect(report).toMatchObject({ passed: 1, failed: 1, skipped: 1, successful: false });
  });
});
