import { Command } from "commander";
import { renderSettings, requestedSettings } from "../../config/effective.js";
import { EXIT } from "../../core/constants.js";
import { err, ok, type Result } from "../../core/result.js";
import { withRuntimeDiagnostic } from "../../core/runtime-agreement.js";
import { runtimeIdentity } from "../../core/version.js";
import { type Check, runChecks } from "../../doctor/checks.js";
import { applyFixes } from "../../doctor/fix.js";
import { withValidationSmoke } from "../../doctor/validation.js";
import { type ValidationLayer, validationLayerSchema } from "../../workflow/artifacts/common.js";
import { foundationBlockers } from "../../workflow/gates/readiness.js";
import { buildFoundationContext, type WorkspaceState } from "../../workflow/state.js";
import { isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check that visp is set up correctly in this project")
    .option(
      "--settings",
      "Explain configured/default values, effective policy and inactive controls",
    )
    .option("--fix", "Repair what can be repaired without a decision")
    .option(
      "--check-command <command>",
      "Run an explicit smoke command through the verification subprocess (executes project code)",
    )
    .option(
      "--check-layer <layer>",
      "Inspect the smoke command as static, unit, integration, or functional evidence",
    )
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{
        fix?: boolean;
        settings?: boolean;
        checkCommand?: string;
        checkLayer?: string;
      }>(command);
      const layer = smokeLayer(opts);
      if (!layer.ok) {
        process.exitCode = emitError("doctor", layer.error, { json: isJson(opts) });
        return;
      }
      const state = opts.fix ? await mutatingWorkspace(opts) : await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("doctor", withRuntimeDiagnostic(state.error), {
          json: isJson(opts),
        });
        return;
      }

      const first = await runChecks(state.value);
      const repairs = opts.fix ? await applyFixes(state.value, first.checks) : [];

      // Re-check after repairing, so the verdict describes the state you leave in.
      const checked = repairs.length > 0 ? await runChecks(state.value) : first;
      const report =
        opts.checkCommand !== undefined
          ? await withValidationSmoke(
              checked,
              opts.checkCommand,
              state.value.paths.root,
              layer.value,
            )
          : checked;
      const remaining = report.checks.filter((check) => check.recovery);
      const featureReadiness = await readFeatureReadiness(state.value);
      const settings = await requestedSettings(state.value, opts.settings);

      process.exitCode = emit(
        "doctor",
        ok({
          runtime: runtimeIdentity(),
          ...report,
          repairs,
          featureReadiness,
          ...settings,
        }),
        {
          json: isJson(opts),
          text: (data) =>
            [
              `visp is ${data.verdict}.`,
              `Runtime: ${data.runtime.version} build ${data.runtime.buildId} (${data.runtime.executable})`,
              "",
              ...data.checks.map(renderCheck),
              ...renderSettings(settings.settings),
              ...(repairs.length > 0
                ? [
                    "",
                    "Repaired:",
                    ...repairs.map(
                      (repair) =>
                        `  ${repair.done ? "ok  " : "FAIL"}  ${repair.name}: ${repair.detail}`,
                    ),
                  ]
                : []),
              ...(remaining.length > 0
                ? [
                    "",
                    opts.fix ? "Still needs you:" : "To fix:",
                    ...remaining.map((check) => `  ${check.name}: ${check.recovery}`),
                  ]
                : []),
              ...renderFeatureReadiness(data.featureReadiness, !!state.value.status?.activeFeature),
            ].join("\n"),
        },
      );

      if (report.verdict === "unhealthy") process.exitCode = EXIT.refused;
    });
}

function renderFeatureReadiness(
  blockers: Awaited<ReturnType<typeof readFeatureReadiness>>,
  active: boolean,
): string[] {
  if (blockers.length === 0) return [];
  return [
    "",
    active ? "Before continuing feature work:" : "Before starting a feature:",
    ...blockers.map(
      ({ requirement, error }) =>
        `  ${requirement}: ${error.message}${error.recovery ? ` Recovery: ${error.recovery}` : ""}`,
    ),
    ...(active
      ? []
      : ["Finish installation before reviewing and committing the project baseline."]),
  ];
}

async function readFeatureReadiness(state: WorkspaceState) {
  const foundation = await buildFoundationContext(state);
  return foundation.ok
    ? foundationBlockers(
        foundation.value,
        state.status?.activeFeature ? "visp next" : 'visp feature "<goal>"',
        !state.status?.activeFeature,
      )
    : [{ requirement: "inspection", error: foundation.error }];
}

function renderCheck(check: Check): string {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL", unknown: "??  " }[check.status];
  return `  ${mark}  ${check.name.padEnd(20)} ${check.detail}`;
}

function smokeLayer(opts: {
  checkLayer?: string;
  checkCommand?: string;
}): Result<ValidationLayer | undefined> {
  if (opts.checkLayer === undefined) return ok(undefined);
  const layer = validationLayerSchema.safeParse(opts.checkLayer);
  if (layer.success && opts.checkCommand) return ok(layer.data);
  return err({
    code: "ARTIFACT_INVALID",
    message:
      "--check-layer requires --check-command and one of static, unit, integration, functional",
  });
}
