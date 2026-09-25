import type { CommandSpec } from "../../core/exec.js";
import type { ValidationLayer } from "../artifacts/common.js";
import type { CodeEvidence, CommandResult, Finding } from "../artifacts/evidence.js";

export interface ValidationCheck {
  readonly command: CommandSpec;
  readonly layer?: ValidationLayer;
  readonly evidenceRole?: "acceptance";
}

/** Turns command results into findings, including the cases where none ran. */
export function describeExecution(execution: {
  results: readonly CommandResult[];
  codeEvidence: CodeEvidence;
  unrunnable: readonly string[];
  blockedBy?: readonly string[];
}): Finding[] {
  const findings: Finding[] = execution.results
    .filter((result) => !result.passed)
    .map((result) => ({
      code: "validation-command-failed",
      severity: "error" as const,
      // A command that never started did not exit, and saying it exited -1
      // describes a run that did not happen.
      message: commandFailureMessage(result),
      ...(result.output ? { recommendation: result.output } : {}),
    }));

  for (const result of execution.results) {
    if (result.passed && (result.testSummary?.skipped ?? 0) > 0) {
      findings.push({
        code: "validation-tests-skipped",
        severity: result.evidenceRole === "acceptance" ? "error" : "warning",
        message: `${result.command} skipped ${result.testSummary?.skipped} tests; those cases remain unchecked`,
        recommendation:
          "Execute required cases in the supported environment and emit criterion receipts only after their assertions run",
      });
    }
  }

  if (execution.codeEvidence === "refused") {
    findings.push({
      code: "validation-refused",
      severity: "error",
      message: execution.blockedBy?.length
        ? `Validation was not run because existing checks failed: ${execution.blockedBy.join(", ")}`
        : "Validation commands were declared but none could run",
      recommendation: execution.blockedBy?.length
        ? "Resolve the reported blockers, then run verification again; no command result was reused"
        : "Check the commands in visp.yml and the task's validationCommands",
    });
  }

  // Some ran, so the run is not `refused` — but the ones that did not still
  // proved nothing, and counting the whole run as executed would hide them.
  if (execution.codeEvidence === "partial") {
    findings.push({
      code: "validation-partial",
      severity: "error",
      message: `Some validation commands could not run: ${execution.unrunnable.join(", ")}`,
      recommendation:
        "One entry is one command; there is no shell. Split a chained command in two, " +
        "or give it as an argv list.",
    });
  }

  return findings;
}

function commandFailureMessage(result: CommandResult): string {
  switch (result.failureKind) {
    case "invalid-report":
      return `${result.command} returned an invalid test report; its reported success cannot establish evidence`;
    case "flaky-tests":
      return `${result.command} contains failed retries; the final pass does not establish a stable result`;
    case "no-tests":
      return `${result.command} executed no passing tests; skipped coverage is not verification`;
    case "assertion":
      return `${result.command} reported failed assertions or runner errors despite exiting zero`;
    case "timeout":
      return `${result.command} timed out before validation completed`;
    default:
      return result.exitCode === -1
        ? `${result.command} could not run`
        : `${result.command} exited ${result.exitCode}`;
  }
}
