import { Command } from "commander";
import { PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { parseProjectFilePath, parseTaskId } from "../../core/input.js";
import { err, ok, type Result } from "../../core/result.js";
import { verificationCommand } from "../../skills/admit.js";
import { couldFireAnywhere } from "../../skills/applies.js";
import { transitionSkill } from "../../skills/lifecycle.js";
import { reconcileLineage } from "../../skills/lineage.js";
import { createProposalFromContent, type ProposalInput } from "../../skills/proposal.js";
import { rollbackSkill } from "../../skills/rollback.js";
import { type SkillRecord, validateSkillId } from "../../skills/schema.js";
import {
  fingerprint,
  parseSkill,
  readIndex,
  readSkillBody,
  readSkillHistory,
} from "../../skills/store.js";
import type { WorkspaceState } from "../../workflow/state.js";
import {
  isJson,
  mutatingWorkspace,
  options,
  validateArtifactSelection,
  workspace,
} from "../context.js";
import { bullet, emit, emitError } from "../output.js";
import { catalogCommand, seedCommand } from "./skill-catalog.js";
import { evaluateSkillCommand, promoteSkillCommand } from "./skill-evaluation.js";

/**
 * Skills a project has learned.
 *
 * Proposing is something an agent may do. Admitting is not: a skill that
 * installs itself is the tool widening what it tells the next agent to do,
 * with nobody having chosen it. Admitted skills are inert here — they are
 * recorded and readable, and a later phase decides when one is worth an agent's
 * attention.
 */
export function skillCommand(): Command {
  const command = new Command("skill").description("Skills this project has learned");

  command.addCommand(catalogCommand());
  command.addCommand(seedCommand());
  command.addCommand(proposeCommand());
  command.addCommand(listCommand());
  command.addCommand(showCommand());
  command.addCommand(diffCommand());
  command.addCommand(exportCommand());
  command.addCommand(importCommand());
  command.addCommand(admitCommand());
  command.addCommand(rejectCommand());
  command.addCommand(retireCommand());
  command.addCommand(historyCommand());
  command.addCommand(rollbackCommand());
  command.addCommand(evaluateSkillCommand());
  command.addCommand(promoteSkillCommand());

  return command;
}

function proposeCommand(): Command {
  return new Command("propose")
    .description(
      "Record an inert skill drawn from finished legacy work or explicitly selected current product slices",
    )
    .requiredOption("--id <id>", "Short name, lowercase words joined by dashes")
    .requiredOption("--file <path>", "The SKILL.md to propose")
    .option(
      "--from-task <id...>",
      "Closed legacy tasks or current product slices this was drawn from",
    )
    .option("--feature <id>", "Which legacy feature or current product feature owns those tasks")
    .option("--by <name>", "Who or what proposed it")
    .option(
      "--origin <origin>",
      "derived from this project's closed work, or seeded from outside it",
      "derived",
    )
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<ProposalOptions>(command);
      const identifiers = validateArtifactSelection(opts);
      if (!identifiers.ok) {
        process.exitCode = emitError("skill", identifiers.error, { json: isJson(opts) });
        return;
      }
      for (const task of opts.fromTask ?? []) {
        const parsed = parseTaskId(task);
        if (!parsed.ok) {
          process.exitCode = emitError("skill", parsed.error, { json: isJson(opts) });
          return;
        }
      }
      const file = parseProjectFilePath(opts.file);
      if (!file.ok) {
        process.exitCode = emitError("skill", file.error, { json: isJson(opts) });
        return;
      }
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const proposed = await createProposal(state.value, { ...opts, file: file.value });
      if (!proposed.ok) {
        process.exitCode = emitError("skill", proposed.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("skill", proposed, {
        json: isJson(opts),
        text: renderProposal,
        nextCommand: (data) => `${PRODUCT_NAME} skill show ${data.id}`,
      });
    });
}

interface ProposalOptions extends ProposalInput {
  readonly file: string;
}

/** One proposal path for local distillation and imported craft knowledge. */
async function createProposal(
  state: WorkspaceState,
  input: ProposalOptions,
): Promise<Result<SkillRecord>> {
  const file = parseProjectFilePath(input.file);
  if (!file.ok) return file;
  const content = await state.files.readTextIfExists(file.value);
  if (!content.ok) return content;
  if (content.value === undefined) {
    return err(vispError("ARTIFACT_MISSING", `No such file: ${input.file}`));
  }

  return createProposalFromContent(state, input, content.value);
}

function renderProposal(data: SkillRecord): string {
  return [
    `Proposed ${data.id} (${data.origin}, ${data.trust})` +
      (data.derivedFrom.length > 0 ? `, drawn from ${data.derivedFrom.join(", ")}` : "") +
      ".",
    "It does nothing until someone admits it.",
    // A skill that can never fire otherwise looks like one that has not matched yet.
    couldFireAnywhere(data.appliesTo) ? "" : `Applies to ${describeTrigger(data.appliesTo)}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function listCommand(): Command {
  return new Command("list")
    .description("Every skill, and where each one stands")
    .option("--state <state>", "Only this state")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{ state?: string }>(command);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      // A skill whose source work is gone is not usable, and saying so at read
      // time means nobody has to remember to run a cleanup.
      const reconciled = await reconcileLineage(state.value);
      if (!reconciled.ok) {
        process.exitCode = emitError("skill", reconciled.error, { json: isJson(opts) });
        return;
      }

      const index = await readIndex(state.value);
      if (!index.ok) {
        process.exitCode = emitError("skill", index.error, { json: isJson(opts) });
        return;
      }

      const skills = opts.state
        ? index.value.skills.filter((skill) => skill.state === opts.state)
        : index.value.skills;

      process.exitCode = emit("skill", ok({ skills }), {
        json: isJson(opts),
        text: (data) =>
          data.skills.length === 0
            ? "No skills yet."
            : bullet(
                data.skills.map(
                  (skill) =>
                    `${skill.state.padEnd(9)} ${skill.trust.padEnd(8)} ${skill.id}` +
                    (skill.reason ? ` — ${skill.reason}` : ""),
                ),
              ),
      });
    });
}

function showCommand(): Command {
  return new Command("show")
    .description("A skill's body, its support, and how it got here")
    .argument("<id>")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const found = await lookup(state.value, id);
      if (!found.ok) {
        process.exitCode = emitError("skill", found.error, { json: isJson(opts) });
        return;
      }

      const body = await readSkillBody(state.value, id);
      const content = body.ok ? (body.value ?? "") : "";
      const document = parseSkill(content);
      if (!document.ok) {
        process.exitCode = emitError("skill", document.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit(
        "skill",
        ok({
          ...found.value,
          verification: verificationCommand(document.value.body),
          body: content,
        }),
        {
          json: isJson(opts),
          text: (data) =>
            [
              `${data.id} — ${data.state}, ${data.origin}, ${data.trust}`,
              describeProvenance(data),
              `Applies to: ${describeTrigger(data.appliesTo)}`,
              data.admittedBy ? `Admitted by ${data.admittedBy} at ${data.admittedAt}` : "",
              data.verification
                ? `Declared check (not execution evidence): ${data.verification}`
                : "",
              `Usefulness: ${data.evidence?.usefulness ?? "unmeasured"} (${data.evidence?.usefulnessBasis ?? "unknown basis"}); source provenance: ${data.evidence?.provenance ?? "unknown"}`,
              data.evaluations?.length
                ? `Reviewed evaluations (model/task scope in each record): ${data.evaluations.join(", ")}`
                : "",
              data.reason ? `Note: ${data.reason}` : "",
              "",
              data.body,
            ]
              .filter(Boolean)
              .join("\n"),
        },
      );
    });
}

/**
 * The work behind a skill, as the record holds it. Never asserts an absence it
 * has not checked: a seeded record that does cite work says so, whatever the
 * origin claims about where it came from.
 */
function describeProvenance(skill: SkillRecord): string {
  if (skill.support?.length)
    return `Drawn from: ${skill.support.map((source) => `${source.feature}/${source.task}`).join(", ")}`;
  if (skill.derivedFrom.length > 0) return `Drawn from: ${skill.derivedFrom.join(", ")}`;
  return skill.origin === "seeded"
    ? "Seeded from outside this project, so no closed work stands behind it."
    : "Drawn from: nothing recorded";
}

function historyCommand(): Command {
  return new Command("history")
    .description("Read immutable skill revisions and transitions")
    .argument("<id>")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }
      process.exitCode = emit("skill", await readSkillHistory(state.value, id), {
        json: isJson(opts),
        text: (events) =>
          events
            .map(
              (event) =>
                `${event.at} ${event.record.state} ${event.record.version ?? "legacy"} ${event.record.admittedBy ?? event.record.proposedBy ?? "unknown"}`,
            )
            .join("\n") || "No immutable history recorded.",
      });
    });
}

function rollbackCommand(): Command {
  return new Command("rollback")
    .description("Restore a previously admitted revision after fresh review")
    .argument("<id>")
    .requiredOption("--revision <sha256>", "Full immutable revision from skill history")
    .requiredOption("--by <name>", "Claimed reviewer name (not authenticated)")
    .requiredOption("--reason <text>", "Why this revision is being restored")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options<{ revision: string; by: string; reason: string }>(command);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }
      process.exitCode = emit("skill", await rollbackSkill(state.value, id, opts.revision, opts), {
        json: isJson(opts),
        text: (record) => `Restored ${record.id}@${record.version}.`,
      });
    });
}

/** Reads back the trigger as declared, so a skill that never fires is explicable. */
function describeTrigger(appliesTo: SkillRecord["appliesTo"]): string {
  const nowhere = "nothing, so it will never enter a context pack";
  if (!appliesTo) return `${nowhere} — it declares no appliesTo`;

  const declared = Object.entries(appliesTo)
    .filter(([, values]) => values.length > 0)
    .map(([dimension, values]) => `${dimension} ${values.join("|")}`);

  if (declared.length === 0) return `${nowhere} — its appliesTo names no dimension`;

  // A stage nothing selects at is a declared trigger that is not a working one.
  return couldFireAnywhere(appliesTo)
    ? declared.join(", ")
    : `${declared.join(", ")} — but nothing assembles context at ${appliesTo.stage.join(
        " or ",
      )} yet, so it will never enter a pack`;
}

function diffCommand(): Command {
  return new Command("diff")
    .description("Whether a skill has been edited since it was admitted")
    .argument("<id>")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const found = await lookup(state.value, id);
      if (!found.ok) {
        process.exitCode = emitError("skill", found.error, { json: isJson(opts) });
        return;
      }

      const body = await readSkillBody(state.value, id);
      const current = body.ok && body.value !== undefined ? fingerprint(body.value) : undefined;
      const changed = current !== found.value.contentHash;

      process.exitCode = emit(
        "skill",
        ok({ id, changed, recorded: found.value.contentHash, current }),
        {
          json: isJson(opts),
          text: (data) =>
            data.current === undefined
              ? `${data.id} has no file on disk.`
              : data.changed
                ? `${data.id} has been edited since it was recorded.`
                : `${data.id} is unchanged since it was recorded.`,
        },
      );
    });
}

function exportCommand(): Command {
  return new Command("export")
    .description("Copy an unchanged admitted SKILL.md without its local admission record")
    .argument("<id>")
    .requiredOption("--file <path>", "Destination path")
    .option("--force", "Replace a different file already at the destination")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options<ExportOptions>(command);
      const checkedId = validateSkillId(id);
      if (!checkedId.ok) {
        process.exitCode = emitError("skill", checkedId.error, { json: isJson(opts) });
        return;
      }
      const file = parseProjectFilePath(opts.file);
      if (!file.ok) {
        process.exitCode = emitError("skill", file.error, { json: isJson(opts) });
        return;
      }
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const exported = await exportSkill(state.value, checkedId.value, {
        ...opts,
        file: file.value,
      });
      process.exitCode = emit("skill", exported, {
        json: isJson(opts),
        text: (data) => `Exported ${data.id} to ${data.file}.`,
      });
    });
}

interface ExportOptions {
  readonly file: string;
  readonly force?: boolean;
}

async function exportSkill(
  state: WorkspaceState,
  id: string,
  input: ExportOptions,
): Promise<Result<{ readonly id: string; readonly file: string }>> {
  const found = await lookup(state, id);
  if (!found.ok) return found;
  if (found.value.state !== "admitted") {
    return err(vispError("UNSUPPORTED", `${id} is ${found.value.state}, not admitted`));
  }

  const body = await readSkillBody(state, id);
  if (!body.ok) return body;
  if (body.value === undefined) {
    return err(vispError("ARTIFACT_MISSING", `${id} has no SKILL.md on disk`));
  }
  if (fingerprint(body.value) !== found.value.contentHash) {
    return err(
      vispError("ARTIFACT_INVALID", `${id} was edited since it was admitted`, {
        recovery: `${PRODUCT_NAME} skill diff ${id}`,
      }),
    );
  }

  const parsedDestination = parseProjectFilePath(input.file);
  if (!parsedDestination.ok) return parsedDestination;
  const destination = parsedDestination.value;
  const existing = await state.files.readTextIfExists(destination);
  if (!existing.ok) return existing;
  if (existing.value !== undefined && existing.value !== body.value && !input.force) {
    return err(
      vispError("ARTIFACT_INVALID", `${input.file} already exists with different content`),
    );
  }

  if (existing.value !== body.value) {
    const written = await state.files.writeTextAtomic(destination, body.value);
    if (!written.ok) return written;
  }
  return ok({ id, file: state.paths.absolute(destination) });
}

function importCommand(): Command {
  return new Command("import")
    .description("Bring in a SKILL.md as an inert seeded proposal")
    .requiredOption("--id <id>", "Local skill id")
    .requiredOption("--file <path>", "SKILL.md to import")
    .option("--by <name>", "Who or what imported it")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options<{ id: string; file: string; by?: string }>(command);
      const checkedId = validateSkillId(opts.id);
      if (!checkedId.ok) {
        process.exitCode = emitError("skill", checkedId.error, { json: isJson(opts) });
        return;
      }
      const file = parseProjectFilePath(opts.file);
      if (!file.ok) {
        process.exitCode = emitError("skill", file.error, { json: isJson(opts) });
        return;
      }
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const id = checkedId.value;

      const index = await readIndex(state.value);
      if (!index.ok) {
        process.exitCode = emitError("skill", index.error, { json: isJson(opts) });
        return;
      }
      if (index.value.skills.some((skill) => skill.id === id)) {
        process.exitCode = emitError(
          "skill",
          vispError("UNSUPPORTED", `A skill named ${id} already exists`),
          { json: isJson(opts) },
        );
        return;
      }

      const imported = await createProposal(state.value, {
        id,
        file: file.value,
        origin: "seeded",
        ...(opts.by ? { by: opts.by } : {}),
      });
      if (!imported.ok) {
        process.exitCode = emitError("skill", imported.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("skill", imported, {
        json: isJson(opts),
        text: (data) =>
          [
            `Imported ${data.id} as a seeded proposal.`,
            "It does nothing until someone admits it in this project.",
            couldFireAnywhere(data.appliesTo)
              ? ""
              : `Applies to ${describeTrigger(data.appliesTo)}.`,
          ]
            .filter(Boolean)
            .join("\n"),
        nextCommand: (data) => `${PRODUCT_NAME} skill show ${data.id}`,
      });
    });
}

function admitCommand(): Command {
  return new Command("admit")
    .description("Accept a proposed skill into the project")
    .argument("<id>")
    .requiredOption("--by <name>", "Who is admitting it")
    .action(async (id: string, _flags: unknown, command: Command) => {
      await transition(command, id, "admitted");
    });
}

function rejectCommand(): Command {
  return new Command("reject")
    .description("Turn down a proposed skill, keeping the record of it")
    .argument("<id>")
    .requiredOption("--reason <text>", "Why")
    .action(async (id: string, _flags: unknown, command: Command) => {
      await transition(command, id, "rejected");
    });
}

function retireCommand(): Command {
  return new Command("retire")
    .description("Stop using an admitted skill, keeping the record of it")
    .argument("<id>")
    .requiredOption("--reason <text>", "Why")
    .action(async (id: string, _flags: unknown, command: Command) => {
      await transition(command, id, "retired");
    });
}

/**
 * Nothing is deleted. What was once admitted, and why it stopped being, is the
 * part worth keeping — the same reason overrides are records rather than edits.
 */
async function transition(
  command: Command,
  id: string,
  next: "admitted" | "rejected" | "retired",
): Promise<void> {
  const opts = options<{ by?: string; reason?: string }>(command);
  const state = await mutatingWorkspace(opts);
  if (!state.ok) {
    process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
    return;
  }

  const result = await transitionSkill(state.value, id, next, opts);
  process.exitCode = emit("skill", result, {
    json: isJson(opts),
    text: (data) => `${data.id} is now ${data.state}.`,
  });
}

async function lookup(state: WorkspaceState, id: string) {
  const checkedId = validateSkillId(id);
  if (!checkedId.ok) return checkedId;

  const index = await readIndex(state);
  if (!index.ok) return index;

  const found = index.value.skills.find((skill) => skill.id === checkedId.value);
  return found
    ? ok(found)
    : {
        ok: false as const,
        error: vispError("ARTIFACT_MISSING", `No skill named ${id}`, {
          recovery: `${PRODUCT_NAME} skill list`,
        }),
      };
}
