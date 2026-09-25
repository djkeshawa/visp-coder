import { pytestJUnit } from "./junit.js";
import { count, object, requiredText } from "./validation-values.js";

export type ReportFormat = "vitest" | "pytest" | "playwright";
export type TestStatus = "passed" | "failed" | "skipped";
export interface ReportedTest {
  readonly id: string;
  readonly status: TestStatus;
  readonly attempts: readonly TestStatus[];
  readonly flaky: boolean;
}
export interface TestReport {
  readonly format: ReportFormat;
  readonly tests: readonly ReportedTest[];
  readonly executed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly flaky: number;
  readonly successful: boolean;
  readonly errors: number;
}

/** Reporter data is execution evidence, never authenticated merely by parsing it. */
export function parseTestReport(format: ReportFormat, input: unknown): TestReport {
  const data = object(
    format === "pytest" && typeof input === "string" ? pytestJUnit(input) : input,
    "report",
  );
  const tests =
    format === "vitest"
      ? vitestTests(data)
      : format === "pytest"
        ? pytestTests(data)
        : playwrightTests(data);
  const ids = new Set<string>();
  for (const test of tests) {
    if (ids.has(test.id)) throw new Error(`Duplicate test identity: ${test.id}`);
    ids.add(test.id);
  }
  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.filter((test) => test.status === "failed").length;
  const skipped = tests.filter((test) => test.status === "skipped").length;
  const flaky = tests.filter((test) => test.flaky).length;
  const errors = reportErrors(format, data);
  verifyCounters(format, data, { passed, failed, skipped, flaky, total: tests.length });
  return {
    format,
    tests,
    passed,
    failed,
    skipped,
    flaky,
    errors,
    executed: passed + failed,
    successful: passed > 0 && failed === 0 && flaky === 0 && errors === 0,
  };
}

function vitestTests(data: Record<string, unknown>): ReportedTest[] {
  return array(data.testResults, "testResults").flatMap((entry) => {
    const suite = object(entry, "testResults entry");
    const name = requiredText(suite.name, "suite name");
    return array(suite.assertionResults, "assertionResults").map((item) => {
      const test = object(item, "assertionResults entry");
      const status = normalizeStatus(test.status);
      return {
        id: `${name}::${requiredText(test.fullName, "test fullName")}`,
        status,
        attempts: [status],
        flaky: false,
      };
    });
  });
}

function pytestTests(data: Record<string, unknown>): ReportedTest[] {
  return array(data.tests, "tests").map((entry) => {
    const test = object(entry, "pytest test");
    const status = normalizeStatus(test.outcome);
    if (status === "passed" && object(test.call, "pytest execution call").outcome !== "passed") {
      throw new Error("Passed pytest test has no successful execution phase");
    }
    return { id: requiredText(test.nodeid, "nodeid"), status, attempts: [status], flaky: false };
  });
}

function playwrightTests(data: Record<string, unknown>): ReportedTest[] {
  const tests: ReportedTest[] = [];
  const pending = [...array(data.suites, "suites")];
  while (pending.length) {
    const suite = object(pending.pop(), "suite");
    if (suite.suites !== undefined) pending.push(...array(suite.suites, "suites"));
    for (const entry of array(suite.specs ?? [], "specs")) {
      const spec = object(entry, "spec");
      for (const test of array(spec.tests, "spec tests"))
        tests.push(playwrightTest(spec, object(test, "test")));
    }
  }
  return tests;
}

function playwrightTest(
  spec: Record<string, unknown>,
  test: Record<string, unknown>,
): ReportedTest {
  const raw = array(test.results, "test results").map(
    (attempt) => object(attempt, "test result").status,
  );
  const attempts = raw.map(normalizeStatus);
  if (!attempts.length && test.status !== "skipped")
    throw new Error("Playwright test contains no execution results");
  const expected = test.expectedStatus ?? "passed";
  normalizeStatus(expected);
  const status = playwrightStatus(raw.at(-1), expected);
  return {
    id: `${requiredText(spec.id, "spec id")}::${projectName(test.projectName)}`,
    status,
    attempts,
    flaky:
      test.status === "flaky" ||
      (status === "passed" && raw.some((result) => result !== expected && result !== "skipped")),
  };
}

function playwrightStatus(actual: unknown, expected: unknown): TestStatus {
  if (actual === undefined || actual === "skipped") return "skipped";
  return actual === expected ? "passed" : "failed";
}

function projectName(value: unknown): string {
  if (typeof value !== "string") throw new Error("projectName must be a string");
  return value || "<default>";
}

function normalizeStatus(value: unknown): TestStatus {
  if (value === "passed") return "passed";
  if (["failed", "timedOut", "interrupted", "error", "xpassed"].includes(String(value)))
    return "failed";
  if (["pending", "todo", "skipped", "disabled", "xfailed"].includes(String(value)))
    return "skipped";
  throw new Error(`Unknown test status: ${String(value)}`);
}

function reportErrors(format: ReportFormat, data: Record<string, unknown>): number {
  if (format === "pytest") return count(data.exitcode, "exitcode") === 0 ? 0 : 1;
  if (format === "playwright") return array(data.errors ?? [], "errors").length;
  return data.success === false
    ? 1
    : count(data.numRuntimeErrorTestSuites ?? 0, "numRuntimeErrorTestSuites");
}

function verifyCounters(
  format: ReportFormat,
  data: Record<string, unknown>,
  actual: {
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
    total: number;
  },
): void {
  const fields =
    format === "vitest"
      ? {
          passed: "numPassedTests",
          failed: "numFailedTests",
          skipped: "numPendingTests",
          total: "numTotalTests",
        }
      : { passed: "passed", failed: "failed", skipped: "skipped", total: "total" };
  const counters = format === "pytest" ? object(data.summary ?? {}, "summary") : data;
  if (format === "playwright") {
    verifyPlaywrightCounters(data, actual);
    return;
  }
  for (const key of ["passed", "failed", "skipped", "total"] as const) {
    const value = counters[fields[key]];
    const extraTodo =
      key === "skipped" && format === "vitest" ? count(data.numTodoTests ?? 0, "numTodoTests") : 0;
    if (value !== undefined && count(value, fields[key]) + extraTodo !== actual[key])
      throw new Error(`Report counter disagrees: ${fields[key]}`);
  }
}

function verifyPlaywrightCounters(
  data: Record<string, unknown>,
  actual: { passed: number; failed: number; skipped: number; flaky: number },
): void {
  if (data.stats === undefined) return;
  const stats = object(data.stats, "stats");
  const derived = {
    expected: actual.passed - actual.flaky,
    unexpected: actual.failed,
    skipped: actual.skipped,
    flaky: actual.flaky,
  };
  for (const [key, value] of Object.entries(derived)) {
    if (count(stats[key], `stats.${key}`) !== value)
      throw new Error(`Report counter disagrees: stats.${key}`);
  }
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
