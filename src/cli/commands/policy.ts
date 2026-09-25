import { Command } from "commander";
import { PRODUCT_NAME, STRICTNESS_MODES, type StrictnessMode } from "../../core/constants.js";
import { ok } from "../../core/result.js";
import { now } from "../../workflow/artifacts/common.js";
import { mutatePolicy } from "../../workflow/policy/mutations.js";
import { resolveRule } from "../../workflow/policy/resolve.js";
import { RULES, type RuleId } from "../../workflow/policy/rules.js";
import { isJson, options, projectRoot, workspace } from "../context.js";
import { emit, emitError } from "../output.js";

export function policyCommand(): Command {
  const command = new Command("policy").description("Inspect or change which rules are enforced");

  command.addCommand(showCommand());
  command.addCommand(setStrictnessCommand());
  command.addCommand(setRuleCommand());
  command.addCommand(validateCommand());

  return command;
}

interface RuleView {
  readonly id: RuleId;
  readonly title: string;
  readonly reason: string;
  readonly stage: string;
  readonly active: boolean;
  readonly why: string;
  readonly overridable: boolean;
}

function showCommand(): Command {
  return new Command("show")
    .description("List every rule and whether it applies right now")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("policy", state.error, { json: isJson(opts) });
        return;
      }

      const rules: RuleView[] = RULES.map((rule) => {
        const resolved = resolveRule(rule.id, state.value.policy, state.value.overrides, {
          feature: state.value.status?.activeFeature,
          task: state.value.status?.activeTask,
        });

        return {
          id: rule.id,
          title: rule.title,
          reason: rule.reason,
          stage: rule.stage,
          active: resolved.active,
          overridable: rule.overridable,
          why: resolved.active
            ? "on"
            : resolved.reason === "overridden"
              ? `overridden: ${resolved.override.reason}`
              : `off in ${state.value.policy.strictness} mode`,
        };
      });

      process.exitCode = emit("policy", ok({ strictness: state.value.policy.strictness, rules }), {
        json: isJson(opts),
        text: renderRules,
      });
    });
}

function renderRules(data: { strictness: string; rules: readonly RuleView[] }): string {
  const lines = [`Strictness: ${data.strictness}`, ""];

  for (const rule of data.rules) {
    const mark = rule.active ? "on " : "off";
    const locked = rule.overridable ? "" : "  (cannot be overridden)";
    lines.push(`  ${mark}  ${rule.id.padEnd(28)} ${rule.title}${locked}`);
    if (!rule.active) lines.push(`       ${rule.why}`);
  }

  lines.push("", `Why each rule exists: ${PRODUCT_NAME} policy show --json`);
  return lines.join("\n");
}

function setStrictnessCommand(): Command {
  return new Command("set-strictness")
    .description("Change how firmly gates refuse")
    .argument("<mode>", STRICTNESS_MODES.join(" | "))
    .action(async (mode: string, _flags: unknown, command: Command) => {
      const opts = options(command);

      if (!STRICTNESS_MODES.includes(mode as StrictnessMode)) {
        process.exitCode = emitError(
          "policy",
          {
            code: "UNSUPPORTED",
            message: `Unknown strictness: ${mode}`,
            recovery: `Use one of: ${STRICTNESS_MODES.join(", ")}`,
          },
          { json: isJson(opts) },
        );
        return;
      }

      const saved = await mutatePolicy(projectRoot(opts), (current) => ({
        ...current,
        strictness: mode as StrictnessMode,
      }));
      if (!saved.ok) {
        process.exitCode = emitError("policy", saved.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("policy", saved, {
        json: isJson(opts),
        text: () => `Strictness is now ${mode}.`,
        nextCommand: () => `${PRODUCT_NAME} policy show`,
      });
    });
}

function setRuleCommand(): Command {
  return new Command("set")
    .description("Turn one rule on or off, overriding the strictness default")
    .argument("<rule>", "A rule id from: visp policy show")
    .argument("<state>", "on | off")
    .action(async (rule: string, value: string, _flags: unknown, command: Command) => {
      const opts = options(command);
      const known = RULES.find((entry) => entry.id === rule);

      if (!known) {
        process.exitCode = emitError(
          "policy",
          {
            code: "UNSUPPORTED",
            message: `Unknown rule: ${rule}`,
            recovery: `${PRODUCT_NAME} policy show`,
          },
          { json: isJson(opts) },
        );
        return;
      }

      if (value !== "on" && value !== "off") {
        process.exitCode = emitError(
          "policy",
          {
            code: "UNSUPPORTED",
            message: `Unknown rule state: ${value}`,
            recovery: "Use on or off",
          },
          { json: isJson(opts) },
        );
        return;
      }

      if (!known.overridable && value === "off") {
        process.exitCode = emitError(
          "policy",
          {
            code: "UNSUPPORTED",
            message: `${rule} cannot be turned off: ${known.reason}`,
          },
          { json: isJson(opts) },
        );
        return;
      }

      const saved = await mutatePolicy(projectRoot(opts), (current) => ({
        ...current,
        createdAt: current.createdAt || now(),
        rules: { ...current.rules, [rule]: value === "on" },
      }));
      if (!saved.ok) {
        process.exitCode = emitError("policy", saved.error, { json: isJson(opts) });
        return;
      }

      process.exitCode = emit("policy", saved, {
        json: isJson(opts),
        text: () => `${rule} is now ${value}.`,
      });
    });
}

/**
 * A recorded policy can outlive the rules it names.
 *
 * `.visp/policy.json` keys decisions by rule id. Upgrade visp and a renamed or
 * retired rule leaves a key behind that reads like a decision and does nothing —
 * the most misleading state a policy file can be in, because the project
 * believes it turned something on. `set` refuses to write a rule that cannot be
 * waived, but a hand-edited file can still hold one.
 *
 * This reports; it never rewrites. What to do about a stale decision is a
 * judgement about the project, and the file belongs to whoever wrote it.
 */
function validateCommand(): Command {
  return new Command("validate")
    .description("Check the recorded policy against the rules this visp knows")
    .action(async (_flags: unknown, command: Command) => {
      const opts = options(command);
      const state = await workspace(opts);
      if (!state.ok) {
        process.exitCode = emitError("policy", state.error, { json: isJson(opts) });
        return;
      }

      const recorded = Object.entries(state.value.policy.rules);
      const unknown: string[] = [];
      const unwaivable: string[] = [];

      for (const [id, enabled] of recorded) {
        const rule = RULES.find((entry) => entry.id === id);
        if (!rule) {
          unknown.push(id);
          continue;
        }
        if (!enabled && !rule.overridable) unwaivable.push(id);
      }

      const problems = unknown.length + unwaivable.length;
      const payload = { checked: recorded.length, unknown, unwaivable };

      if (problems === 0) {
        process.exitCode = emit("policy", ok(payload), {
          json: isJson(opts),
          text: (data) =>
            data.checked === 0
              ? "No rule decisions are recorded, so strictness alone decides."
              : `All ${data.checked} recorded decision(s) name a rule this visp knows.`,
        });
        return;
      }

      process.exitCode = emitError(
        "policy",
        {
          code: "CONFIG_INVALID",
          message: [
            `${problems} recorded decision(s) no longer hold:`,
            ...unknown.map((id) => `  - ${id} names no rule this visp knows`),
            ...unwaivable.map((id) => `  - ${id} is turned off but cannot be waived`),
          ].join("\n"),
          recovery: `${PRODUCT_NAME} policy show`,
        },
        { json: isJson(opts) },
      );
    });
}
