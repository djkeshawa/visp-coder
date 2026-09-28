import type { ValidationLayer } from "../workflow/artifacts/common.js";
import { namesBrowserRunner } from "../workflow/artifacts/criteria.js";
import { runValidationCommands } from "../workflow/evidence/commands.js";
import { inspectValidationQuality } from "../workflow/evidence/test-quality.js";
import { describeExecution } from "../workflow/evidence/verify-support.js";
import type { Check, DoctorReport } from "./checks.js";

/** Explicit opt-in smoke test; product verification supplies its own environment and context. */
export async function withValidationSmoke(
  report: DoctorReport,
  command: string,
  cwd: string,
  layer?: ValidationLayer,
): Promise<DoctorReport> {
  const execution = await runValidationCommands([command], cwd);
  const effectiveLayer = layer ?? (namesBrowserRunner(command) ? "functional" : undefined);
  const findings = [
    ...describeExecution(execution),
    ...(await inspectValidationQuality(cwd, [{ command, layer: effectiveLayer }], {
      requiredLayers: effectiveLayer ? [effectiveLayer] : [],
    })),
  ];
  const check: Check = {
    name: "validation smoke",
    status:
      !execution.passed || findings.some((finding) => finding.severity === "error")
        ? "fail"
        : findings.length > 0
          ? "warn"
          : "ok",
    detail:
      findings.length > 0
        ? findings.map((finding) => finding.message).join("; ")
        : `${command} completed as a smoke check with the current shell environment; product verification adds its own environment and check context. This does not certify feature acceptance`,
    ...(findings.length > 0
      ? {
          recovery:
            findings
              .map((finding) => finding.recommendation)
              .filter(Boolean)
              .join("\n") ||
            "Inspect the command and its runtime environment before starting the task",
        }
      : {}),
  };
  return {
    checks: [...report.checks, check],
    verdict:
      check.status === "fail"
        ? "unhealthy"
        : check.status === "warn" && report.verdict === "healthy"
          ? "degraded"
          : report.verdict,
  };
}
