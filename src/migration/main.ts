import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { emit } from "../cli/output.js";
import { fromUnknown } from "../core/errors.js";
import { VERSION } from "../core/version.js";
import { applyMigration, exportMigrationHistory, previewMigration } from "./operations.js";

export function buildMigrationProgram() {
  const program = new Command("visp-migrate")
    .description("Preview, preserve and transactionally upgrade VISP history")
    .version(VERSION)
    .option("--project <path>", "Project root")
    .exitOverride();
  for (const operation of ["preview", "apply"] as const) {
    program
      .command(operation)
      .option("--feature <id>", "Select a feature")
      .action(async (_flags, command: Command) => {
        const options = command.optsWithGlobals();
        const result = await (operation === "preview" ? previewMigration : applyMigration)(
          resolve(options.project ?? process.cwd()),
          options.feature,
        );
        process.exitCode = emit<unknown>(operation, result, { json: true });
      });
  }
  program
    .command("export")
    .requiredOption("--name <name>", "New export name under .visp/exports")
    .action(async (_flags, command: Command) => {
      const options = command.optsWithGlobals();
      process.exitCode = emit(
        "export",
        await exportMigrationHistory(resolve(options.project ?? process.cwd()), options.name),
        { json: true },
      );
    });
  return program;
}
const entry = process.argv[1];
let invoked = false;
try {
  invoked = !!entry && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  /* Imported modules are inert. */
}
if (invoked)
  buildMigrationProgram()
    .parseAsync(process.argv)
    .catch((cause) => {
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        String(cause.code).startsWith("commander.")
      ) {
        process.exitCode = Number(cause.exitCode ?? 1);
      } else
        process.exitCode = emit(
          "migration",
          { ok: false, error: fromUnknown(cause) },
          { json: true },
        );
    });
