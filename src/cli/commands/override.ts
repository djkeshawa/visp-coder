import { Command } from "commander";
import { PRODUCT_NAME, STAGES, type Stage } from "../../core/constants.js";
import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { now } from "../../workflow/artifacts/common.js";
import { mutateOverrides } from "../../workflow/policy/mutations.js";
import { RULES } from "../../workflow/policy/rules.js";
import type { Override } from "../../workflow/policy/schema.js";
import { overrideSchema } from "../../workflow/policy/schema.js";
import { isJson, options, projectRoot, validateArtifactSelection, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

/**
 * Recorded exceptions. An override says who allowed what, where, why, and until
 * when — an exception nobody wrote down is indistinguishable from a rule that
 * was never enforced.
 */
export function overrideCommand(): Command {
  const command = new Command("override").description("Record or revoke an exception to a rule");

  command.addCommand(createCommand());
  command.addCommand(listCommand());
  command.addCommand(revokeCommand());

  return command;
}

const DEFAULT_DAYS = 7;

function createCommand(): Command {
  return new Command("create")
    .description("Allow one rule to be waived, for a stated reason and a limited time")
    .argument("<rule>", "A rule id from: visp policy show")
    .requiredOption("--reason <text>", "Why this exception is justified")
    .option("--feature <id>", "Limit the exception to one feature")
    .option("--task <id>", "Limit the exception to one task")
    .option("--stage <stage>", `Limit the exception to one stage (${STAGES.join(", ")})`)
    .option("--days <n>", `How long it lasts (default ${DEFAULT_DAYS})`, Number.parseInt)
    .action(async (rule: string, _flags: unknown, command: Command) => {
      const opts = options<{
        reason: string;
        feature?: string;
        task?: string;
        stage?: string;
        days?: number;
      }>(command);

      const identifiers = validateArtifactSelection(opts);
      if (!identifiers.ok) {
        process.exitCode = emitError("override", identifiers.error, { json: isJson(opts) });
        return;
      }

      const saved = await mutateOverrides(projectRoot(opts), (current) => {
        const built = buildOverride(rule, opts, current.length);
        return built.ok ? ok({ overrides: [...current, built.value], value: built.value }) : built;
      });
      if (!saved.ok) {
        process.exitCode = emitError("override", saved.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("override", saved, {
        json: isJson(opts),
        text: (created) =>
          [
            `Recorded ${created.id}: ${created.rule} is waived until ${created.expiresAt.slice(0, 10)}.`,
            `Reason: ${created.reason}`,
            describeScope(created),
          ]
            .filter(Boolean)
            .join("\n"),
      });
    });
}

function buildOverride(
  rule: string,
  opts: { reason: string; feature?: string; task?: string; stage?: string; days?: number },
  existing: number,
): Result<Override> {
  const known = RULES.find((entry) => entry.id === rule);
  if (!known) {
    return err(
      vispError("UNSUPPORTED", `Unknown rule: ${rule}`, {
        recovery: `${PRODUCT_NAME} policy show`,
      }),
    );
  }

  if (!known.overridable) {
    return err(vispError("UNSUPPORTED", `${rule} cannot be overridden: ${known.reason}`));
  }

  if (opts.stage && !STAGES.includes(opts.stage as Stage)) {
    return err(
      vispError("UNSUPPORTED", `Unknown stage: ${opts.stage}`, {
        recovery: `Use one of: ${STAGES.join(", ")}`,
      }),
    );
  }

  const days = opts.days ?? DEFAULT_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const candidate = {
    id: `OV${String(existing + 1).padStart(3, "0")}`,
    rule,
    reason: opts.reason,
    scope: {
      ...(opts.feature ? { feature: opts.feature } : {}),
      ...(opts.task ? { task: opts.task } : {}),
      ...(opts.stage ? { stage: opts.stage } : {}),
    },
    createdAt: now(),
    expiresAt,
  };

  const parsed = overrideSchema.safeParse(candidate);
  if (!parsed.success) {
    return err(
      vispError("CONFIG_INVALID", parsed.error.issues.map((issue) => issue.message).join("; ")),
    );
  }
  return ok(parsed.data);
}

function listCommand(): Command {
  return new Command("list")
    .description("Show recorded exceptions and whether they still apply")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("override", state.error, { json: isJson(opts) });
        return;
      }

      const at = Date.now();
      const entries = state.value.overrides.map((override) => ({
        ...override,
        status: statusOf(override, at),
      }));

      process.exitCode = emit("override", ok(entries), {
        json: isJson(opts),
        text: (list) =>
          list.length === 0
            ? "No exceptions recorded."
            : list
                .map((entry) =>
                  [
                    `${entry.id}  ${entry.rule}  [${entry.status}]`,
                    `  ${entry.reason}`,
                    describeScope(entry),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                )
                .join("\n\n"),
      });
    });
}

function revokeCommand(): Command {
  return new Command("revoke")
    .description("End an exception now")
    .argument("<id>", "An override id from: visp override list")
    .action(async (id: string, _flags: unknown, command: Command) => {
      const opts = options(command);
      const saved = await mutateOverrides(projectRoot(opts), (current) => {
        if (!current.some((override) => override.id === id)) {
          return err(
            vispError("ARTIFACT_MISSING", `No override with id ${id}`, {
              recovery: `${PRODUCT_NAME} override list`,
            }),
          );
        }
        // Keep revoked entries as the record of what was allowed and when it stopped.
        return ok({
          overrides: current.map((override) =>
            override.id === id ? { ...override, revokedAt: now() } : override,
          ),
          value: { id },
        });
      });
      if (!saved.ok) {
        process.exitCode = emitError("override", saved.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("override", saved, {
        json: isJson(opts),
        text: () => `${id} is revoked.`,
      });
    });
}

function statusOf(override: Override, at: number): "active" | "expired" | "revoked" {
  if (override.revokedAt) return "revoked";
  return new Date(override.expiresAt).getTime() > at ? "active" : "expired";
}

function describeScope(override: Override): string {
  const parts = [
    override.scope.feature ? `feature ${override.scope.feature}` : "",
    override.scope.task ? `task ${override.scope.task}` : "",
    override.scope.stage ? `stage ${override.scope.stage}` : "",
  ].filter(Boolean);

  return parts.length === 0 ? "  Applies project-wide." : `  Applies to: ${parts.join(", ")}`;
}
