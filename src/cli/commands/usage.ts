import { Command } from "commander";
import { vispError } from "../../core/errors.js";
import { parseProjectFilePath } from "../../core/input.js";
import { importCodexUsage } from "../../telemetry/codex.js";
import { rebuildTelemetryProjection } from "../../telemetry/journal.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
import { emit, emitError } from "../output.js";

export function usageCommand(): Command {
  const usage = new Command("usage").description("Import measured usage from a supported host");
  usage.addCommand(
    new Command("rebuild")
      .description("Rebuild the usage projection from immutable local events")
      .action(async (_flags: unknown, command: Command) => {
        const opts = options(command);
        const state = await mutatingWorkspace(opts);
        const result = state.ok ? await rebuildTelemetryProjection(state.value) : state;
        process.exitCode = emit("usage rebuild", result, {
          json: isJson(opts),
          text: () => "Rebuilt telemetry from local event history; provenance is unchanged.",
        });
      }),
  );

  usage.addCommand(
    new Command("import")
      .description("Import one explicit host usage record")
      .requiredOption("--source <host>", "Usage source (codex)")
      .requiredOption("--file <path>", "Codex rollout JSONL file")
      .action(async (_flags: unknown, command: Command) => {
        const opts = options<{ source: string; file: string }>(command);
        if (opts.source !== "codex") {
          process.exitCode = emitError(
            "usage import",
            vispError("UNSUPPORTED", `Unsupported usage source: ${opts.source}`),
            { json: isJson(opts) },
          );
          return;
        }
        const file = parseProjectFilePath(opts.file);
        if (!file.ok) {
          process.exitCode = emitError("usage import", file.error, { json: isJson(opts) });
          return;
        }
        const state = await mutatingWorkspace(opts);
        if (!state.ok) {
          process.exitCode = emitError("usage import", state.error, { json: isJson(opts) });
          return;
        }

        const result = await importCodexUsage(state.value, file.value);

        process.exitCode = emit("usage import", result, {
          json: isJson(opts),
          text: ({ imported, receipt }) =>
            imported
              ? `Imported Codex usage for ${receipt.runId}.`
              : `Codex usage for ${receipt.runId} was already imported.`,
        });
      }),
  );

  return usage;
}
