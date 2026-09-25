import { Command } from "commander";
import { balancedCritic, CRITIC_HARNESSES, configuredCriticMode } from "../../config/critic.js";
import {
  readCriticDefaults,
  saveCriticDefaults,
  saveCriticEnabled,
  saveCriticMode,
} from "../../config/critic-defaults.js";
import { ok } from "../../core/result.js";
import { isJson, options } from "../context.js";
import { emit } from "../output.js";

export function criticDefaultsCommand() {
  return new Command("defaults")
    .description(
      "Inspect defaults or explicitly save user-wide defaults for future features; no model calls",
    )
    .option("--mode <mode>", "auto, manual, both, or off for new features")
    .option("--harness <name>", CRITIC_HARNESSES.join(", "))
    .option("--save", "Save future-feature defaults, preserving existing overrides")
    .option("--model <id>", "Exact host model ID")
    .option("--reasoning <effort>", "low, medium, high, xhigh")
    .option("--max-calls <number>", "1–6 calls per feature", Number)
    .option("--on", "Enable automatic critic for new features, optionally for one host")
    .option("--off", "Disable automatic critic for new features, optionally for one host")
    .action(async (_flags, command: Command) => {
      const opts = options<{
        mode?: string;
        harness?: string;
        save?: boolean;
        model?: string;
        reasoning?: string;
        maxCalls?: number;
        off?: boolean;
        on?: boolean;
      }>(command);
      if (opts.mode !== undefined && (opts.on || opts.off))
        throw new Error("Choose mode or on/off");
      if (opts.on && opts.off) throw new Error("Choose either --on or --off");
      if (
        !opts.save &&
        (opts.mode !== undefined ||
          opts.model !== undefined ||
          opts.reasoning !== undefined ||
          opts.maxCalls !== undefined ||
          opts.off ||
          opts.on)
      )
        throw new Error("Use --save to change defaults; inspection is read-only");
      const result = await defaultsOperation(opts);
      const enriched = result.ok
        ? ok({
            ...result.value,
            modeByDefault: configuredCriticMode(result.value.value) ?? "auto",
            enabledByDefault: ["auto", "both"].includes(
              configuredCriticMode(result.value.value) ?? "auto",
            ),
            presets: Object.fromEntries(CRITIC_HARNESSES.map((h) => [h, balancedCritic(h)])),
            note: "Built-in presets are cost-conscious hypotheses, not proven optimal models. Overrides affect new features only; project critic settings take precedence. Use visp critic --feature <id> --on or --off to change an existing feature.",
          })
        : result;
      process.exitCode = emit<Record<string, unknown>>("critic-defaults", enriched, {
        json: isJson(opts),
        text: (value) => JSON.stringify(value, null, 2),
      });
    });
}

interface DefaultsOptions {
  save?: boolean;
  mode?: string;
  harness?: string;
  model?: string;
  reasoning?: string;
  maxCalls?: number;
  off?: boolean;
  on?: boolean;
}

async function defaultsOperation(opts: DefaultsOptions) {
  if (!opts.save) return readCriticDefaults();
  if (!opts.harness) return saveGlobalDefaults(opts);
  return saveCriticDefaults(opts.harness, {
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.on || opts.off ? { enabled: opts.on === true } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.reasoning !== undefined ? { reasoningEffort: opts.reasoning } : {}),
    ...(opts.maxCalls !== undefined ? { maxCalls: opts.maxCalls } : {}),
  });
}

async function saveGlobalDefaults(opts: DefaultsOptions) {
  if (opts.mode !== undefined) {
    if (opts.model !== undefined || opts.reasoning !== undefined || opts.maxCalls !== undefined)
      throw new Error("Use --harness for model or budget defaults");
    return saveCriticMode(opts.mode);
  }
  if (opts.model !== undefined || opts.reasoning !== undefined || opts.maxCalls !== undefined)
    throw new Error("Use --harness <host> to change model or budget defaults");
  if (!opts.on && !opts.off)
    throw new Error("Use --on or --off to change defaults globally, or select --harness <host>");
  return saveCriticEnabled(opts.on === true);
}
