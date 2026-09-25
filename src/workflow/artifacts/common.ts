import { z } from "zod";
import { TASK_CLASSES, TASK_STATUSES } from "../../core/constants.js";

export { featureIdSchema, riskLevelSchema, taskIdSchema } from "../../core/input.js";

/** Vocabulary shared by more than one artifact schema. */

export const requirementIdSchema = z
  .string()
  .regex(/^REQ\d{3,}$/, "Requirement id must look like REQ001");

export const qualityRequirementIdSchema = z
  .string()
  .regex(/^NFR\d{3,}$/, "Quality requirement id must look like NFR001");

export const scenarioIdSchema = z
  .string()
  .regex(/^SCN\d{3,}$/, "Scenario id must look like SCN001");

export const researchFindingIdSchema = z
  .string()
  .regex(/^FND\d{3,}$/, "Research finding id must look like FND001");

export const requirementReferenceSchema = z.union([
  requirementIdSchema,
  qualityRequirementIdSchema,
]);

export const engineeringReferenceSchema = z.union([
  requirementIdSchema,
  qualityRequirementIdSchema,
  scenarioIdSchema,
]);

export const criterionIdSchema = z
  .string()
  .regex(/^AC\d{3,}$/, "Acceptance criterion id must look like AC001");

export const isoTimestampSchema = z.string().datetime({ offset: true });

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a sha256 hex digest");

/**
 * A validation command: a string to split, or an argv vector given directly.
 * There is no shell, so one entry is one command — the array form is for an
 * argument that only looks like shell syntax, not for chaining.
 */
export const commandSpecSchema = z.union([z.string(), z.array(z.string()).nonempty()]);

/** The kind of evidence a validation command is expected to produce. */
export const validationLayerSchema = z.enum(["static", "unit", "integration", "functional"]);
export type ValidationLayer = z.infer<typeof validationLayerSchema>;

/** Runtime needed to execute a criterion command. Kept explicit so prose is never classified. */
export const verificationEnvironmentSchema = z.enum(["project", "browser"]);
export type VerificationEnvironment = z.infer<typeof verificationEnvironmentSchema>;

/** How an acceptance criterion says it can be settled. */
export const verificationKindSchema = z.enum(["command", "computed", "inspection"]);

export const taskClassSchema = z.enum(TASK_CLASSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);

/** A repository-relative POSIX path, or a glob over such paths. */
export const pathPatternSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "Path must be repository-relative")
  .refine((value) => !value.includes(".."), "Path must not escape the repository");

/** Provenance of an artifact this one was derived from. */
export const provenanceSchema = z.object({
  path: z.string(),
  hash: sha256Schema,
});

export type Provenance = z.infer<typeof provenanceSchema>;

/** Every artifact carries its kind and when it was written. */
export function artifactEnvelope<Kind extends string>(kind: Kind) {
  return {
    kind: z.literal(kind),
    createdAt: isoTimestampSchema,
  };
}

export function now(): string {
  return new Date().toISOString();
}
