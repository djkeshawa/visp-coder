import { z } from "zod";
import {
  DEFAULT_BLOCKED_PATHS,
  DEFAULT_HARNESS,
  DEFAULT_PRESET,
  DEFAULT_PROFILE,
  DEFAULT_STRICTNESS,
  HARNESSES,
  LANGUAGES,
  LIMITS,
  PRESETS,
  PROFILES,
  STRICTNESS_MODES,
} from "../core/constants.js";
import { acceptanceCheckSchema } from "../workflow/artifacts/acceptance.js";
import { commandSpecSchema } from "../workflow/artifacts/common.js";
import { criticDefaultsSchema } from "./critic.js";

/**
 * The `visp.yml` contract. Every key is optional; defaults come from
 * core/constants so the file and the code cannot disagree.
 */

const workflowSchema = z
  .object({
    strictness: z.enum(STRICTNESS_MODES).default(DEFAULT_STRICTNESS),
    reviewMode: z.enum(["current", "observation-preview"]).default("current"),
    maxChangedFiles: z.number().int().positive().default(40),
    blockedPaths: z.array(z.string()).default([...DEFAULT_BLOCKED_PATHS]),
    validationCommands: z.array(commandSpecSchema).default([]),
    /** Operator-defined feature checks, pinned at feature creation and run by final-task verify. */
    acceptanceChecks: z.array(acceptanceCheckSchema).default([]),
    /** Historical telemetry preference; current product verification does not dispatch flip checks. */
    flipCheck: z.enum(["off", "auto", "on"]).default("auto"),
  })
  .strict()
  .default({});

const graphSchema = z
  .object({
    languages: z.array(z.enum(LANGUAGES)).default([...LANGUAGES]),
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().int().positive().default(LIMITS.maxFileBytes),
  })
  .strict()
  .default({});

const contextSchema = z
  .object({
    tokenBudget: z.number().int().positive().default(LIMITS.contextTokenBudget),
    maxSnippets: z.number().int().positive().default(LIMITS.maxSnippets),
  })
  .strict()
  .default({});

/**
 * A person admits every skill. Automatic activation is unsupported until its
 * evaluation and authority boundaries have been demonstrated.
 *
 * `maxPerPack` is a safety property rather than a budget knob. More skills is
 * not monotonically better — an uncurated library measurably degrades a strong
 * model — so a small cap, paired with an exact trigger, is what keeps a growing
 * library from quietly becoming the thing that makes the agent worse. Zero
 * selects none, which is a narrower switch than turning skills off entirely.
 */
const skillsSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z
      .enum(["review", "auto"])
      .default("review")
      .refine(
        (mode) => mode === "review",
        "Automatic skill admission is unsupported; set skills.mode to review",
      ),
    minSupport: z.number().int().positive().default(3),
    maxPerPack: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({});

const memorySchema = z
  .object({ enabled: z.boolean().default(true) })
  .strict()
  .default({});

const telemetrySchema = z
  .object({ enabled: z.boolean().default(true) })
  .strict()
  .default({});

export const configSchema = z
  .object({
    preset: z.enum(PRESETS).default(DEFAULT_PRESET),
    harness: z.enum(HARNESSES).default(DEFAULT_HARNESS),
    profile: z.enum(PROFILES).default(DEFAULT_PROFILE),
    workflow: workflowSchema,
    graph: graphSchema,
    context: contextSchema,
    skills: skillsSchema,
    memory: memorySchema,
    telemetry: telemetrySchema,
    critic: criticDefaultsSchema.optional(),
  })
  .strict();

export type VispConfig = z.output<typeof configSchema>;
export type VispConfigInput = z.input<typeof configSchema>;

export type WorkflowConfig = VispConfig["workflow"];
export type GraphConfig = VispConfig["graph"];
export type ContextConfig = VispConfig["context"];

/** The config that applies when no `visp.yml` exists. */
export function defaultConfig(): VispConfig {
  return configSchema.parse({});
}
