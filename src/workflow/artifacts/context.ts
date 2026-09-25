import { z } from "zod";
import {
  artifactEnvelope,
  featureIdSchema,
  isoTimestampSchema,
  sha256Schema,
  taskIdSchema,
} from "./common.js";
import { designBriefSchema } from "./design.js";
import { findingSchema } from "./evidence.js";
import { behaviorScenarioSchema, qualityRequirementSchema, requirementSchema } from "./feature.js";

/** Why a file was included, so a reader can judge the selection. */
export const selectionReasonSchema = z.enum([
  "allowed-file",
  "expected-file",
  "structural-neighbour",
  "task-term-match",
  "dependency-output",
  "test-of-allowed-file",
  /** A failing verification or review named this file in its output. */
  "named-in-failure",
  "entrypoint",
  "project-config",
  /** An admitted skill whose trigger fired. Its file is the SKILL.md under `.visp/`. */
  "skill",
]);

export type SelectionReason = z.infer<typeof selectionReasonSchema>;

/**
 * A line range worth reading, named when the graph knows what lives there. The
 * pack's primary answer is these ranges — an agent that can read files needs
 * "where to look", not a copy of what is already on disk.
 */
export const contextRegionSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    /** e.g. "function makeToken", "exported class TokenStore". Absent for regex-derived windows. */
    label: z.string().optional(),
  })
  .strict();

export type ContextRegion = z.infer<typeof contextRegionSchema>;

export const contextFileSchema = z
  .object({
    path: z.string(),
    reason: selectionReasonSchema,
    hash: sha256Schema,
    /** Where to read, whether or not snippet text was materialised. */
    regions: z.array(contextRegionSchema).default([]),
    /** Bounded excerpts rather than whole files, when the snippet cap applies. */
    snippets: z
      .array(
        z
          .object({
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            text: z.string(),
          })
          .strict(),
      )
      .default([]),
    /** What this entry costs to deliver, framing included — not just snippet text. */
    estimatedTokens: z.number().int().nonnegative().default(0),
    truncated: z.boolean().default(false),
  })
  .strict();

export type ContextFile = z.infer<typeof contextFileSchema>;

/**
 * What the last failed attempt at this task said, carried into the next pack.
 *
 * This is evidence about an attempt, not a repository file, so it does not
 * masquerade as one. The files the failure named do go through the ordinary
 * selection machinery, under `named-in-failure`.
 */
export const attemptFeedbackSchema = z
  .object({
    source: z.enum(["verification", "review"]),
    /** `createdAt` of the failed record this feedback was read from. */
    capturedAt: isoTimestampSchema,
    attempt: z.number().int().positive().optional(),
    failingCommands: z
      .array(
        z
          .object({
            command: z.string(),
            exitCode: z.number().int(),
            output: z.string(),
          })
          .strict(),
      )
      .default([]),
    /** Findings from the failed record. Nothing has re-checked them; the name says so. */
    unresolvedFindings: z.array(findingSchema).default([]),
    /** Paths the failure output named that exist in the repository. */
    referencedFiles: z.array(z.string()).default([]),
  })
  .strict();

export type AttemptFeedback = z.infer<typeof attemptFeedbackSchema>;

export const contextContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureGoal: z.string(),
    sourceBrief: z.string(),
    description: z.string(),
    allowedFiles: z.array(z.string()),
    forbiddenFiles: z.array(z.string()),
    expectedFiles: z.array(z.string()),
    validationCommands: z.array(z.string()),
    doneCriteria: z.array(z.string()),
    requirements: z.array(requirementSchema),
    qualityRequirements: z.array(qualityRequirementSchema),
    scenarios: z.array(behaviorScenarioSchema),
    decisions: z.array(z.string()),
    invariants: z.array(z.string()),
    openQuestions: z.array(z.string()),
    designBrief: designBriefSchema.optional(),
  })
  .strict();

export type ContextContract = z.infer<typeof contextContractSchema>;

export const contextPackSchema = z
  .object({
    ...artifactEnvelope("context"),
    feature: featureIdSchema,
    task: taskIdSchema,
    goal: z.string(),
    contract: contextContractSchema.optional(),
    /** Repository-relative canonical artifact containing the full omission ledger. */
    artifactRef: z.string().optional(),
    /** Only the model-facing preview is shortened; the canonical ledger stays complete. */
    omissionPreviewLimit: z.number().int().min(0).max(8).optional(),
    skillDiagnostics: z.array(z.string()).optional(),
    files: z.array(contextFileSchema).default([]),
    /** Files that were selected but did not fit the budget — a gap, stated. */
    omitted: z
      .array(
        z.object({ path: z.string(), reason: selectionReasonSchema, detail: z.string() }).strict(),
      )
      .default([]),
    /** Structural facts the graph knows and the agent would otherwise guess. */
    entrypoints: z.array(z.string()).default([]),
    /** What the graph could not determine, stated rather than hidden. */
    unknowns: z.array(z.string()).default([]),
    attemptFeedback: attemptFeedbackSchema.optional(),
    /** Set when the index this pack was built from trails the worktree. */
    staleIndex: z.string().optional(),
    estimatedTokens: z.number().int().nonnegative(),
    /** Required context is retained even when it exceeds the configured budget. */
    budgetStatus: z.enum(["within-budget", "essential-overflow"]).optional(),
    tokenBudget: z.number().int().positive(),
    graphAvailable: z.boolean(),
    /** True only when no indexable project source existed when this pack was compiled. */
    graphDeferred: z.boolean().optional(),
  })
  .strict();

export type ContextPack = z.infer<typeof contextPackSchema>;

/**
 * Pins the artifacts a context pack was built from. A checkpoint compares these
 * hashes so work grounded in a since-changed spec is caught rather than trusted.
 */
export const contextManifestSchema = z
  .object({
    ...artifactEnvelope("context-manifest"),
    feature: featureIdSchema,
    task: taskIdSchema,
    sources: z.array(z.object({ path: z.string(), hash: sha256Schema }).strict()).default([]),
    contextHash: sha256Schema,
    /** Published repository graph used to derive structural selections and regions. */
    graphSnapshotId: z.string().min(1).optional(),
  })
  .strict();

export type ContextManifest = z.infer<typeof contextManifestSchema>;
