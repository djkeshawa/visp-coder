import { parseTestReport, type ReportFormat } from "../../core/test-reports.js";
import { optionalObject } from "../../core/validation-values.js";
import type { CommandResult } from "../artifacts/evidence.js";

/** Runner-reported counts are evidence of results, not an attestation of authenticity. */
export function runnerTestSummary(output: string): CommandResult["testSummary"] {
  const tap = nodeTestSummary(output);
  if (tap) return tap;
  const data = jsonReport(output);
  const format = data && reportFormat(data);
  if (!format) return undefined;
  // Recognized but invalid reports must reach the command failure path.
  const report = parseTestReport(format, data);
  return {
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    ...(report.flaky ? { flaky: report.flaky } : {}),
    ...(report.errors ? { errors: report.errors } : {}),
  };
}

function jsonReport(output: string): Record<string, unknown> | undefined {
  try {
    return optionalObject(JSON.parse(output));
  } catch {
    return undefined;
  }
}

function reportFormat(data: Record<string, unknown>): ReportFormat | undefined {
  if ("suites" in data && ("stats" in data || "config" in data || "errors" in data))
    return "playwright";
  if ("testResults" in data) return "vitest";
  if ("tests" in data && "exitcode" in data) return "pytest";
  return undefined;
}

/** Only consume the complete, top-level Node TAP footer; test prose is not a counter. */
export function nodeTestSummary(output: string): CommandResult["testSummary"] {
  if (!/^TAP version 13\r?$/m.test(output)) return undefined;
  const footer =
    /^# tests (\d+)\r?\n# suites \d+\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms [\d.]+\s*$/.exec(
      output.slice(output.lastIndexOf("\n# tests ") + 1),
    );
  if (!footer) return undefined;
  const [total = NaN, passed = NaN, failed = NaN, cancelled = NaN, skipped = NaN, todo = NaN] =
    footer.slice(1).map(Number);
  if (
    [total, passed, failed, cancelled, skipped, todo].some((value) => !Number.isSafeInteger(value))
  )
    return undefined;
  if (total !== passed + failed + cancelled + skipped + todo) return undefined;
  return { passed, failed: failed + cancelled, skipped: skipped + todo };
}
