import { z } from "zod";
import { artifactEnvelope, featureIdSchema, researchFindingIdSchema } from "./common.js";

const researchQuestionIdSchema = z
  .string()
  .regex(/^RQ\d{3,}$/, "Research question id must look like RQ001");

export const researchSourceSchema = z
  .object({
    kind: z.enum(["repository", "experiment", "official-docs", "external", "user"]),
    reference: z.string().min(1),
    detail: z.string().default(""),
  })
  .strict();

export const researchImplicationSchema = z
  .object({
    kind: z.enum(["functional", "quality", "architecture", "test", "task"]),
    statement: z.string().min(1),
  })
  .strict();

export const researchChallengeSchema = z
  .object({
    method: z.enum(["repository-trace", "experiment", "source-check", "user-decision"]),
    outcome: z.enum(["supported", "rejected", "inconclusive"]),
    detail: z.string().min(1),
    /** What observable result would disprove the technical claim. */
    falsifier: z.string().min(1).optional(),
    /** Boundary or counterexample cases exercised by an experiment. */
    cases: z.array(z.string().min(1)).max(8).optional(),
  })
  .strict();

export const researchQuestionSchema = z
  .object({
    id: researchQuestionIdSchema,
    /** What kind of uncertainty this question settles. Optional for legacy artifacts. */
    focus: z
      .enum(["repository", "domain", "architecture", "verification", "constraint"])
      .optional(),
    question: z.string().min(1),
    /** True when a wrong answer would change requirements, design, tests, or scope. */
    loadBearing: z.boolean().optional(),
    status: z.enum(["open", "answered", "deferred", "not-applicable"]),
    answer: z.string().optional(),
  })
  .strict();

export const researchFindingSchema = z
  .object({
    id: researchFindingIdSchema,
    classification: z.enum(["fact", "inference"]),
    statement: z.string().min(1),
    confidence: z.enum(["low", "medium", "high"]),
    /** The question this finding settles. Optional only for legacy artifacts. */
    question: researchQuestionIdSchema.optional(),
    /** A consequential finding must survive a trace, check, experiment, or explicit decision. */
    loadBearing: z.boolean().optional(),
    challenge: researchChallengeSchema.optional(),
    sources: z.array(researchSourceSchema).max(8).default([]),
    implications: z.array(researchImplicationSchema).max(8).default([]),
  })
  .strict();

/**
 * Bounded discovery before specification. "Research" does not imply web
 * browsing: repository evidence and small local experiments come first, and
 * unresolved claims remain explicit unknowns rather than guessed facts.
 */
export const researchSchema = z
  .object({
    ...artifactEnvelope("research"),
    feature: featureIdSchema,
    mode: z.enum(["greenfield", "enhancement", "bugfix", "refactor", "investigation", "other"]),
    summary: z.string().default(""),
    questions: z.array(researchQuestionSchema).min(1).max(12),
    findings: z.array(researchFindingSchema).max(24).default([]),
    unknowns: z.array(z.string().min(1)).max(12).default([]),
    draft: z.boolean().default(true),
  })
  .strict();

export type Research = z.infer<typeof researchSchema>;
