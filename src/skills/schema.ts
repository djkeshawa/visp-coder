import { z } from "zod";
import { LANGUAGES, STAGES, TASK_CLASSES } from "../core/constants.js";
import { vispError } from "../core/errors.js";
import { taskRefSchema } from "../core/identity.js";
import { err, ok, type Result } from "../core/result.js";
import {
  artifactEnvelope,
  isoTimestampSchema,
  sha256Schema,
  taskIdSchema,
} from "../workflow/artifacts/common.js";

/**
 * What a learned skill is, and what is known about where it came from.
 *
 * The lineage fields are not bookkeeping. A skill is distilled from work, and
 * distillation launders whatever went into it — so the question "should this be
 * trusted" cannot be answered by reading the skill. It is answered by what the
 * skill can be traced to and who admitted it.
 */

export const SKILL_STATES = ["proposed", "admitted", "rejected", "retired", "orphaned"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

/**
 * `declared` names a proposed check, never an executed one. `verified` is a
 * legacy spelling read conservatively as `declared` by the store.
 */
export const SKILL_TRUST = ["declared", "verified", "advisory"] as const;
export type SkillTrust = (typeof SKILL_TRUST)[number];

/**
 * Where a skill came from, which decides what admitting it has to establish.
 *
 * `derived` is distilled from this project's own closed work, so the question
 * is whether that work happened — support is the check. `seeded` is craft
 * knowledge imported from outside, where there is no local work to point at and
 * demanding some would only encourage inventing it. Neither origin buys any
 * authority: a person still admits it, and `skill.cannot-widen-scope` applies
 * to both, because where a lesson came from says nothing about what it asks for.
 */
export const SKILL_ORIGINS = ["derived", "seeded"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export const skillEvidenceSchema = z
  .object({
    verification: z
      .object({
        declaredCommand: z.string().min(1).optional(),
        execution: z.enum(["not-run", "unknown"]),
      })
      .strict(),
    provenance: z.enum(["local-recorded", "external-unverified", "unknown"]),
    /** This importer records reviewed claims; it does not authenticate outcomes or analyses. */
    usefulness: z.enum(["unmeasured", "inconclusive", "beneficial", "harmful"]),
    usefulnessBasis: z.enum(["unmeasured", "operator-reviewed-claim", "unknown"]).optional(),
  })
  .strict();
export type SkillEvidence = z.infer<typeof skillEvidenceSchema>;

/** Content-addressed observations of closed local work; no producer authentication implied. */
export const skillSupportSchema = z
  .object({
    ...taskRefSchema.shape,
    taskHash: sha256Schema,
    verificationHash: sha256Schema.optional(),
    reviewHash: sha256Schema.optional(),
  })
  .strict();
export type SkillSupport = z.infer<typeof skillSupportSchema>;

export const skillIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, "Skill id must be lowercase words joined by dashes");

/** Skill ids become directory names, so reject them before any path is built. */
export function validateSkillId(id: string): Result<string> {
  const parsed = skillIdSchema.safeParse(id);
  return parsed.success
    ? ok(parsed.data)
    : err(
        vispError(
          "UNSUPPORTED",
          `Skill id "${id}" is invalid: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        ),
      );
}

/**
 * The entrypoint kinds a skill may name.
 *
 * Copied from the graph's own list rather than imported: `appliesTo` is
 * evaluated inside `workflow/`, which must not depend on `graph/`. The copy is
 * held to the original by a unit test, so it cannot drift in silence.
 */
export const SKILL_ENTRYPOINT_KINDS = [
  "http_route",
  "cli_command",
  "package_entrypoint",
  "package_script",
  "test_entrypoint",
  "page_entrypoint",
] as const;
export type SkillEntrypointKind = (typeof SKILL_ENTRYPOINT_KINDS)[number];

/**
 * `stage: plan` is the same claim as `stage: [plan]`, and reads better. A key
 * left bare is YAML's `null` and is the idiomatic way to write "no constraint",
 * so it means the same as leaving the key out.
 */
function oneOrMany<T extends z.ZodTypeAny>(values: T) {
  return z.preprocess(
    (raw) => (raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]),
    z.array(values).default([]),
  );
}

/**
 * Where a skill applies, as a structural trigger.
 *
 * Deliberately not similarity. visp's whole claim is that the same repository
 * in the same state produces the same answer; an embedding score is neither
 * stable across model versions nor explainable to the person reviewing a pack.
 * Every dimension here is an exact match against a fact the project already
 * records, so a skill firing — or not firing — can be argued about.
 *
 * Dimensions are ANDed and the values within one are ORed: naming a dimension
 * is a condition, leaving it empty is not a claim. A record that names no
 * dimension at all therefore applies nowhere, which is the point — see
 * `applies.ts` for why that is the safe default rather than everywhere.
 *
 * `paths` is not a scope. It decides whether a skill is worth an agent's
 * attention on this task and nothing else; what may be written still comes from
 * the task graph, which is why this is not one of the claims a skill may not
 * carry.
 */
export const skillAppliesToSchema = z
  .object({
    /** Globs that must cover an entry of the task's declared file scope. */
    paths: oneOrMany(z.string().min(1)),
    taskClass: oneOrMany(z.enum(TASK_CLASSES)),
    entrypointKind: oneOrMany(z.enum(SKILL_ENTRYPOINT_KINDS)),
    language: oneOrMany(z.enum(LANGUAGES)),
    /** The most useful seeded skills fire at `spec` or `plan`, before any task exists. */
    stage: oneOrMany(z.enum(STAGES)),
  })
  .strict();

export type SkillAppliesTo = z.infer<typeof skillAppliesToSchema>;

/**
 * The `appliesTo` a SKILL.md declares, if any.
 *
 * A malformed trigger is an error rather than an absent one. Silently dropping
 * it would file a skill that can never fire and tell nobody, which looks
 * identical to a skill that simply never matched.
 */
export function readAppliesTo(
  frontmatter: Record<string, unknown>,
): Result<SkillAppliesTo | undefined> {
  const key = Object.keys(frontmatter).find(
    (name) => name.toLowerCase().replace(/[_-]/g, "") === "appliesto",
  );
  const raw = key === undefined ? undefined : frontmatter[key];
  if (raw === undefined || raw === null) return ok(undefined);

  const parsed = skillAppliesToSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(
        vispError(
          "ARTIFACT_INVALID",
          `Its "${key}" is not a trigger this can evaluate: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "appliesTo"} ${issue.message}`)
            .join("; ")}`,
        ),
      );
}

export const skillRecordSchema = z
  .object({
    id: skillIdSchema,
    name: z.string().min(1),
    description: z.string().default(""),
    state: z.enum(SKILL_STATES),
    trust: z.enum(SKILL_TRUST),
    evidence: skillEvidenceSchema.optional(),
    /** Defaulted so an index written before origins existed still reads as what it was. */
    origin: z.enum(SKILL_ORIGINS).default("derived"),
    /** Closed tasks this was distilled from. The support for admitting it. */
    derivedFrom: z.array(taskIdSchema).default([]),
    support: z.array(skillSupportSchema).optional(),
    minSupport: z.number().int().positive().optional(),
    /** Immutable content, applicability and support revision. Missing on legacy records. */
    version: sha256Schema.optional(),
    /** Immutable reviews; their model/task applicability lives in each evaluation. */
    evaluations: z.array(sha256Schema).optional(),
    /** Absent means it applies nowhere, and it is recorded so a pack can be explained. */
    appliesTo: skillAppliesToSchema.optional(),
    feature: z.string().optional(),
    proposedBy: z.string().optional(),
    /** Of the SKILL.md as admitted, so a later edit is visible. */
    contentHash: z.string(),
    createdAt: isoTimestampSchema,
    admittedBy: z.string().optional(),
    admittedAt: isoTimestampSchema.optional(),
    /** Why it was rejected or retired, kept because the record is the point. */
    reason: z.string().optional(),
  })
  .strict();

export type SkillRecord = z.infer<typeof skillRecordSchema>;

export const skillIndexSchema = z
  .object({
    ...artifactEnvelope("skills"),
    skills: z.array(skillRecordSchema).default([]),
  })
  .strict();

export type SkillIndex = z.infer<typeof skillIndexSchema>;
