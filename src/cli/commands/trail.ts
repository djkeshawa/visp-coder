import { Command } from "commander";
import { pruneProductTrail } from "../../workflow/product/trail.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
import { emit, emitError } from "../output.js";

export function trailCommand(): Command {
  const command = new Command("trail").description("Maintain local evidence artifacts");
  command
    .command("prune")
    .description("Remove unreferenced captures and candidate snapshots")
    .option("--feature <id>", "Select a feature")
    .action(async (_flags: unknown, self: Command) => {
      const opts = options<{ feature?: string }>(self);
      const workspace = await mutatingWorkspace(opts);
      process.exitCode = workspace.ok
        ? emit("trail prune", await pruneProductTrail(workspace.value, opts.feature), {
            json: isJson(opts),
            text: (value) =>
              `Removed ${value.removed} unreferenced local artifacts.${"note" in value ? ` ${value.note}` : ""}`,
          })
        : emitError("trail prune", workspace.error, { json: isJson(opts) });
    });
  return command;
}
