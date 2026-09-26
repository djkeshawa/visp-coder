import { Command } from "commander";
import {
  projectRulesText,
  readProjectRules,
  removeProjectRule,
} from "../../workflow/product/project-rules.js";
import { isJson, mutatingWorkspace, options, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function rulesCommand(): Command {
  const command = new Command("rules")
    .description("Show the rules the user stated for all later work on this project")
    .action(async (_flags: unknown, self: Command) => {
      const opts = options(self);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("rules", state.error, { json: isJson(opts) });
        return;
      }
      const recorded = await readProjectRules(state.value);
      process.exitCode = emit(
        "rules",
        recorded.ok ? { ok: true as const, value: recorded.value.rules } : recorded,
        {
          json: isJson(opts),
          text: (rules) =>
            projectRulesText(rules) ||
            "No project rules recorded. VISP records them from a request that states rules for later work.",
        },
      );
    });
  command
    .command("remove")
    .description("Remove a recorded project rule")
    .argument("<id>", "Rule id, such as R001")
    .action(async (id: string, _flags: unknown, self: Command) => {
      const opts = options(self);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("rules", state.error, { json: isJson(opts) });
        return;
      }
      process.exitCode = emit("rules", await removeProjectRule(state.value, id), {
        json: isJson(opts),
        text: (rule) => `Removed ${rule.id}: ${rule.text}`,
      });
    });
  return command;
}
