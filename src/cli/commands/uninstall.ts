import { Command } from "commander";
import { HARNESSES } from "../../core/constants.js";
import { parseHarness } from "../../core/input.js";
import { type UninstallOutcome, uninstallHarness } from "../../harness/uninstall.js";
import { isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function uninstallCommand(): Command {
  return new Command("uninstall")
    .description("Remove what visp install wrote and still recognizes as its own")
    .option("--harness <name>", `Which coder (${HARNESSES.join(", ")}); defaults to visp.yml's`)
    .option("--dry-run", "Preview what would be removed or edited without changing anything")
    .option(
      "--force",
      "Also remove files and hook entries you edited, and proceed while a slice is authorized",
    )
    .action(handleUninstallCommand);
}

interface UninstallCliOptions {
  readonly harness?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
}

async function handleUninstallCommand(_flags: unknown, command: Command): Promise<void> {
  const opts = options<UninstallCliOptions>(command);
  const json = isJson(opts);
  const harness = opts.harness ? parseHarness(opts.harness) : undefined;
  if (harness && !harness.ok) {
    process.exitCode = emitError("uninstall", harness.error, { json });
    return;
  }
  const state = opts.dryRun ? await workspace(opts) : await mutatingWorkspace(opts);
  if (!state.ok) {
    process.exitCode = emitError("uninstall", state.error, { json });
    return;
  }
  const result = await uninstallHarness(state.value.paths, {
    harness: harness?.ok ? harness.value : state.value.config.harness,
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.force ? { force: true } : {}),
  });
  process.exitCode = emit("uninstall", result, { json, text: renderUninstall });
}

const VERB = { remove: "remove ", edit: "edit   ", restore: "restore" } as const;

function renderUninstall(outcome: UninstallOutcome): string {
  const heading = outcome.dryRun
    ? `Uninstall preview for ${outcome.harness}; no files changed.`
    : `Uninstalled visp from ${outcome.harness}.`;
  return [
    heading,
    ...outcome.changes.map(
      (change) =>
        `  ${VERB[change.operation]}  ${change.path}${change.detail ? `  (${change.detail})` : ""}`,
    ),
    ...(outcome.changes.length === 0 ? ["  Nothing of visp's to remove."] : []),
    ...(outcome.kept.length > 0
      ? ["", "Left in place:", ...outcome.kept.map((kept) => `  ${kept.path}: ${kept.reason}`)]
      : []),
    "",
    ...outcome.manualSteps.map((step) => `- ${step}`),
  ].join("\n");
}
