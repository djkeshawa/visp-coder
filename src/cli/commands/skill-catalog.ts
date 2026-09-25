import { Command } from "commander";
import { PRODUCT_NAME } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { bundledSkill, skillCatalog } from "../../skills/catalog.js";
import { createProposalFromContent } from "../../skills/proposal.js";
import type { SkillRecord } from "../../skills/schema.js";
import { readIndex, readSkillBody } from "../../skills/store.js";
import type { WorkspaceState } from "../../workflow/state.js";
import { isJson, mutatingWorkspace, options } from "../context.js";
import { bullet, emit, emitError } from "../output.js";

export function catalogCommand(): Command {
  return new Command("catalog")
    .description("Curated skills available to seed into this project")
    .option(
      "--show <id>",
      "Print bundled content for inspection or an explicit replacement proposal",
    )
    .action((_flags: unknown, command: Command) => {
      const opts = options<{ show?: string }>(command);
      if (opts.show !== undefined) {
        const skill = bundledSkill(opts.show);
        process.exitCode = emit(
          "skill",
          skill
            ? ok(skill)
            : err(
                vispError("ARTIFACT_MISSING", `No bundled skill named ${opts.show}`, {
                  recovery: `${PRODUCT_NAME} skill catalog`,
                }),
              ),
          { json: isJson(opts), text: (data) => data.content },
        );
        return;
      }
      const skills = skillCatalog();

      process.exitCode = emit("skill", ok({ skills }), {
        json: isJson(opts),
        text: (data) =>
          bullet(
            data.skills.map(
              (skill) =>
                `${skill.id}@${skill.version} [${skill.stages.join(", ")}] — ${skill.description}`,
            ),
          ),
      });
    });
}

interface SeedOutcome {
  readonly skill: SkillRecord;
  readonly created: boolean;
}

export function seedCommand(): Command {
  return new Command("seed")
    .description("Copy a bundled skill into this project as an inert proposal")
    .argument("<id>")
    .requiredOption("--by <name>", "Who chose to seed it")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options<{ by: string }>(command);
      const state = await mutatingWorkspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("skill", state.error, { json: isJson(opts) });
        return;
      }

      const seeded = await seedCatalogSkill(state.value, id, opts.by);
      process.exitCode = emit("skill", seeded, {
        json: isJson(opts),
        text: (data) =>
          data.created
            ? [
                `Seeded ${data.skill.id} as a seeded proposal.`,
                "It does nothing until someone admits it in this project.",
              ].join("\n")
            : `${data.skill.id} already exists unchanged (${data.skill.state}).`,
        nextCommand: (data) => `${PRODUCT_NAME} skill show ${data.skill.id}`,
      });
    });
}

async function seedCatalogSkill(
  state: WorkspaceState,
  id: string,
  proposedBy: string,
): Promise<Result<SeedOutcome>> {
  const catalogSkill = bundledSkill(id);
  if (!catalogSkill) {
    return err(
      vispError("ARTIFACT_MISSING", `No bundled skill named ${id}`, {
        recovery: `${PRODUCT_NAME} skill catalog`,
      }),
    );
  }

  const index = await readIndex(state);
  if (!index.ok) return index;

  const existingRecord = index.value.skills.find((skill) => skill.id === id);
  const existingBody = await readSkillBody(state, id);
  if (!existingBody.ok) return existingBody;

  if (existingRecord) {
    const unchanged =
      existingRecord.contentHash === catalogSkill.summary.contentHash &&
      existingBody.value === catalogSkill.content;
    return unchanged
      ? ok({ skill: existingRecord, created: false })
      : err(
          vispError(
            "ARTIFACT_INVALID",
            `A skill named ${id} already exists with different content`,
            { recovery: `${PRODUCT_NAME} skill show ${id}` },
          ),
        );
  }

  if (existingBody.value !== undefined && existingBody.value !== catalogSkill.content) {
    return err(
      vispError(
        "ARTIFACT_INVALID",
        `A skill file named ${id} already exists with different content`,
      ),
    );
  }

  const proposed = await createProposalFromContent(
    state,
    { id, origin: "seeded", by: proposedBy },
    catalogSkill.content,
  );
  return proposed.ok ? ok({ skill: proposed.value, created: true }) : proposed;
}
