import { z } from "zod";
import {
  HARNESSES,
  type Harness,
  PROFILES,
  type Profile,
  RISK_LEVELS,
  type RiskLevel,
} from "./constants.js";
import { vispError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

/** Command-facing vocabulary that must be narrowed before it reaches workflow code. */
export const HOOK_KINDS = ["claude", "git", "ci"] as const;
export type HookKindInput = (typeof HOOK_KINDS)[number];
export const WORKFLOW_MODES = ["full", "compact"] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export const featureIdSchema = z
  .string()
  .regex(/^\d{3}-[a-z0-9][a-z0-9-]*$/, "Feature id must look like 001-short-slug");

export const taskIdSchema = z.string().regex(/^T\d{3,}$/, "Task id must look like T001");

export const riskLevelSchema = z.enum(RISK_LEVELS);

export function parseHarness(value: string): Result<Harness> {
  return parseEnum(value, HARNESSES, "harness", `Use one of: ${HARNESSES.join(", ")}`);
}

export function parseProfile(value: string): Result<Profile> {
  return parseEnum(value, PROFILES, "profile", `Use one of: ${PROFILES.join(", ")}`);
}

export function parseHookKind(value: string): Result<HookKindInput> {
  return parseEnum(value, HOOK_KINDS, "hook kind", `Use one of: ${HOOK_KINDS.join(", ")}`);
}

export function parseRiskLevel(value: string): Result<RiskLevel> {
  return parseEnum(value, RISK_LEVELS, "risk level", `Use one of: ${RISK_LEVELS.join(", ")}`);
}

export function parseWorkflowMode(value: string): Result<WorkflowMode> {
  return parseEnum(
    value,
    WORKFLOW_MODES,
    "workflow mode",
    `Use one of: ${WORKFLOW_MODES.join(", ")}`,
  );
}

export function parseFeatureId(value: string): Result<string> {
  return parseArtifactId(value, featureIdSchema, "feature", "visp status");
}

export function parseTaskId(value: string): Result<string> {
  return parseArtifactId(value, taskIdSchema, "task", "visp status");
}

/**
 * Narrows a user-supplied file argument to a portable project-relative path.
 *
 * Import/export commands are still explicit, but they must not become an
 * ambient read or write primitive outside the project an agent was given.
 * Users can copy a file into or out of the project when crossing that boundary
 * is intentional.
 */
export function parseProjectFilePath(value: string): Result<string> {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (
    value.length === 0 ||
    value.includes("\0") ||
    normalized === "." ||
    normalized.endsWith("/") ||
    isPortableAbsoluteInput(normalized) ||
    segments.includes("..")
  ) {
    return err(
      vispError("ARTIFACT_INVALID", `File path must stay inside the project: ${value}`, {
        recovery: "Use a project-relative file path without parent traversal",
        details: { value },
      }),
    );
  }

  const compact = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return compact.length > 0
    ? ok(compact)
    : err(vispError("ARTIFACT_INVALID", `File path must name a file: ${value}`));
}

function parseEnum<const Values extends readonly string[]>(
  value: string,
  allowed: Values,
  label: string,
  recovery: string,
): Result<Values[number]> {
  if (allowed.includes(value as Values[number])) return ok(value as Values[number]);
  return err(
    vispError("UNSUPPORTED", `Unknown ${label}: ${value}`, {
      recovery,
      details: { value, allowed },
    }),
  );
}

function parseArtifactId(
  value: string,
  schema: z.ZodType<string>,
  label: string,
  recovery: string,
): Result<string> {
  if (schema.safeParse(value).success) return ok(value);
  return err(
    vispError("ARTIFACT_INVALID", `"${value}" is not a ${label} id`, {
      recovery,
      details: { value },
    }),
  );
}

function isPortableAbsoluteInput(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:\//i.test(value) || value.startsWith("//");
}
