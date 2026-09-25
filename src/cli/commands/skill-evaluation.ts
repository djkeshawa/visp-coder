import { Command } from "commander";
import { vispError } from "../../core/errors.js";
import { parseProjectFilePath } from "../../core/input.js";
import { promoteSkill, recordSkillEvaluation } from "../../skills/evaluation.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
import { emit, emitError } from "../output.js";

export function evaluateSkillCommand(): Command {
  return new Command("evaluate")
    .description("Record an operator-reviewed claim from a paired held-out skill evaluation")
    .argument("<id>")
    .requiredOption("--file <path>", "Project-relative evaluation JSON")
    .requiredOption("--by <name>", "Claimed reviewer of the supplied analysis")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options<{ file: string; by: string }>(command);
      const path = parseProjectFilePath(opts.file);
      if (!path.ok) {
        process.exitCode = emitError("skill", path.error, { json: isJson(opts) });
        return;
      }
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }
      const source = await state.value.files.readTextIfExists(path.value);
      if (!source.ok) {
        process.exitCode = emitError("skill", source.error, { json: isJson(opts) });
        return;
      }
      if (source.value === undefined) {
        process.exitCode = emitError(
          "skill",
          vispError("ARTIFACT_MISSING", `No evaluation file ${opts.file}`),
          { json: isJson(opts) },
        );
        return;
      }
      process.exitCode = emit(
        "skill",
        await recordSkillEvaluation(state.value, id, source.value, opts.by),
        {
          json: isJson(opts),
          text: (result) =>
            [
              `Recorded operator-reviewed claim ${result.id}: ${result.evaluation.input.decision} for ${result.evaluation.input.model}/${result.evaluation.input.taskClass}.`,
              "Provenance: operator-supplied analysis; receipt hashes do not authenticate an evaluator.",
              `${result.skill.id} is ${result.skill.state}.`,
            ].join("\n"),
        },
      );
    });
}

export function promoteSkillCommand(): Command {
  return new Command("promote")
    .description("Activate a revision against a bound operator-reviewed benefit claim")
    .argument("<id>")
    .requiredOption("--evaluation <sha256>", "Immutable beneficial evaluation id")
    .requiredOption("--by <name>", "Claimed reviewer activating this revision")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options<{ evaluation: string; by: string }>(command);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }
      process.exitCode = emit(
        "skill",
        await promoteSkill(state.value, id, opts.evaluation, opts.by),
        {
          json: isJson(opts),
          text: (record) =>
            `Admitted ${record.id}@${record.version} against operator-reviewed claim ${opts.evaluation}; empirical benefit is not authenticated by this command.`,
        },
      );
    });
}
