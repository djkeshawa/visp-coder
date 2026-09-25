import {
  type CommandOutput,
  type CommandSpec,
  describeCommand,
  resolveCommand,
  run,
} from "../../core/exec.js";
import type { CodeEvidence, CommandResult } from "../artifacts/evidence.js";
import { parseEvidenceReceipts } from "./contract-receipts.js";
import { runnerTestSummary } from "./test-summary.js";

/**
 * Runs a task's validation commands and reports honestly what happened.
 *
 * The tri-state matters: a run that *should* have executed commands but could
 * not is `refused`, never a pass. Silence about a check that never ran is the
 * failure mode this whole tool exists to prevent. `partial` is the same
 * argument applied to a mixed run — reporting it as `executed` because
 * something ran hides the check that did not.
 */

export interface CommandRunOutcome {
  readonly results: CommandResult[];
  readonly codeEvidence: CodeEvidence;
  readonly passed: boolean;
  /** Commands that never started, named so a report can say which. */
  readonly unrunnable: string[];
  /** Existing deterministic blockers that prevented execution, not failed commands. */
  readonly blockedBy?: readonly string[];
}

const MAX_OUTPUT_CHARS = 4_000;

export async function runValidationCommands(
  commands: readonly CommandSpec[],
  cwd: string,
): Promise<CommandRunOutcome> {
  if (commands.length === 0) {
    return { results: [], codeEvidence: "delegated", passed: true, unrunnable: [] };
  }

  const results: CommandResult[] = [];
  const unrunnable: string[] = [];

  for (const spec of commands) {
    const command = describeCommand(spec);
    const argv = resolveCommand(spec);

    if (!argv.ok) {
      unrunnable.push(command);
      results.push({
        command,
        exitCode: -1,
        passed: false,
        durationMs: 0,
        output: argv.error.message,
        failureKind: "invalid-command",
      });
      continue;
    }

    const [file, ...args] = argv.value as [string, ...string[]];
    const output = await run(file, args, { cwd });

    if (!output.ok) {
      unrunnable.push(command);
      results.push({
        command,
        exitCode: -1,
        passed: false,
        durationMs: 0,
        output: output.error.message,
        failureKind: "spawn",
      });
      continue;
    }

    results.push(toResult(command, output.value));
  }

  const executed = results.length - unrunnable.length;

  return {
    results,
    codeEvidence: executed === 0 ? "refused" : unrunnable.length > 0 ? "partial" : "executed",
    passed: executed > 0 && results.every((result) => result.passed),
    unrunnable,
  };
}

function toResult(command: string, output: CommandOutput): CommandResult {
  const raw = `${output.stdout}\n${output.stderr}`.trim();
  const detail = output.timedOut ? "Command timed out" : truncate(raw);
  const assertedCriteria = assertionReceipts(raw);
  let testSummary: CommandResult["testSummary"];
  let evidenceReceipts: CommandResult["evidenceReceipts"];
  try {
    evidenceReceipts = parseEvidenceReceipts(raw);
    testSummary = runnerTestSummary(output.stdout.trim());
  } catch (error) {
    return {
      command,
      exitCode: output.exitCode,
      passed: false,
      durationMs: output.durationMs,
      failureKind: invalidReportKind(output),
      output: truncate(
        `Invalid test report: ${error instanceof Error ? error.message : String(error)}\n${raw}`,
      ),
    };
  }
  const failureKind =
    commandFailure(output, assertedCriteria, testSummary) ??
    (evidenceReceipts.some((entry) => entry.outcome === "failed") ? "assertion" : undefined);
  const passed = failureKind === undefined;

  return {
    command,
    exitCode: output.exitCode,
    passed,
    durationMs: output.durationMs,
    ...(failureKind ? { failureKind } : {}),
    ...(testSummary ? { testSummary } : {}),
    ...(assertedCriteria.length > 0 ? { assertedCriteria } : {}),
    ...(evidenceReceipts.length > 0 ? { evidenceReceipts } : {}),
    ...(passed ? {} : { output: detail }),
  };
}

function invalidReportKind(output: CommandOutput): CommandResult["failureKind"] {
  if (output.timedOut) return "timeout";
  return output.exitCode !== 0 ? "exit" : "invalid-report";
}

function commandFailure(
  output: CommandOutput,
  receipts: NonNullable<CommandResult["assertedCriteria"]>,
  summary: CommandResult["testSummary"],
): CommandResult["failureKind"] {
  if (output.timedOut) return "timeout";
  if (output.exitCode !== 0) return "exit";
  if (
    receipts.some((receipt) => receipt.outcome === "failed") ||
    (summary?.failed ?? 0) > 0 ||
    (summary?.errors ?? 0) > 0
  )
    return "assertion";
  if ((summary?.flaky ?? 0) > 0) return "flaky-tests";
  return summary?.passed === 0 ? "no-tests" : undefined;
}

/**
 * A broad command can cover several criteria only when it says which assertion
 * it actually exercised. Test runners may emit these lines from their reporter:
 * `VISP_ASSERT AC001 passed`.
 */
export function assertionReceipts(
  output: string,
): Array<{ criterion: string; outcome: "passed" | "failed" }> {
  const receipts = new Map<string, "passed" | "failed">();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?VISP_ASSERT\s+(AC\d{3,})\s+(passed|failed)\s*$/i.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const criterion = match[1].toUpperCase();
    const outcome = match[2].toLowerCase() as "passed" | "failed";
    // Contradictory assertions are conservative: one failure keeps it failed.
    if (outcome === "failed" || !receipts.has(criterion)) receipts.set(criterion, outcome);
  }
  return [...receipts].map(([criterion, outcome]) => ({ criterion, outcome }));
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... output truncated`;
}
