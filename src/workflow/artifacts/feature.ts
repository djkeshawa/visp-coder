import { z } from "zod";
import { acceptanceBaselineSchema } from "./acceptance.js";
import {
  artifactEnvelope,
  criterionIdSchema,
  engineeringReferenceSchema,
  featureIdSchema,
  pathPatternSchema,
  qualityRequirementIdSchema,
  requirementIdSchema,
  researchFindingIdSchema,
  riskLevelSchema,
  scenarioIdSchema,
  sha256Schema,
  taskIdSchema,
  validationLayerSchema,
  verificationEnvironmentSchema,
  verificationKindSchema,
} from "./common.js";
import { designBriefSchema } from "./design.js";
import { evidenceContractSchema } from "./evidence-contract.js";

/** Raw user intent, recorded verbatim before any interpretation. */
export const intentSchema = z
  .object({
    ...artifactEnvelope("intent"),
    id: featureIdSchema,
    goal: z.string().min(1),
    /** Verbatim request supplied at feature creation, before later interpretation. */
    sourceBrief: z.string().min(1).optional(),
    /** Hash of sourceBrief so reports can identify the contract they evaluated. */
    sourceBriefHash: sha256Schema.optional(),
    riskLevel: riskLevelSchema,
    branch: z.string().optional(),
    /** New features enter the built-in research stage; absent on legacy intents. */
    researchRequired: z.boolean().optional(),
    /** Additive 0.4 workflow choice; absence means the legacy/full workflow. */
    workflow: z.enum(["full", "compact"]).optional(),
    acceptanceBaseline: acceptanceBaselineSchema.optional(),
    /** New features finish with executable acceptance of the assembled product. */
    finalAcceptance: z.literal(true).optional(),
    /** Newly created features require explicit evidence expectations; legacy intents are unchanged. */
    evidenceContractsRequired: z.literal(true).optional(),
  })
  .strict();

export type Intent = z.infer<typeof intentSchema>;

export const acceptanceCriterionSchema = z
  .object({
    id: criterionIdSchema,
    statement: z.string().min(1),
    /**
     * How this criterion is checked: a command, an inspection, or a test name.
     *
     * Review runs it when — and only when — it is written as code, a backtick
     * span or a fenced block, on a line of its own. Prose is left as prose: it
     * is recorded as an unchecked criterion rather than guessed at, because a
     * criterion visp cannot run is one a person still has to settle.
     */
    verification: z.string().optional(),
    /** Explicit type for new artifacts; omitted only by legacy specifications. */
    verificationKind: verificationKindSchema.optional(),
    /** The evidence boundary this command exercises. Required for new command criteria. */
    verificationLayer: validationLayerSchema.optional(),
    /** Runtime that must execute the check. Explicit for new functional criteria. */
    verificationEnvironment: verificationEnvironmentSchema.optional(),
    /** Advisory rendered-output evidence required in addition to verification. */
    observationKind: z.literal("visual").optional(),
    evidenceContract: evidenceContractSchema.optional(),
  })
  .strict();

export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const requirementSchema = z
  .object({
    id: requirementIdSchema,
    statement: z.string().min(1),
    priority: z.enum(["must", "should", "could"]).default("must"),
    criteria: z.array(acceptanceCriterionSchema).default([]),
  })
  .strict();

export type Requirement = z.infer<typeof requirementSchema>;

export const qualityRequirementSchema = z
  .object({
    id: qualityRequirementIdSchema,
    category: z.enum([
      "performance",
      "reliability",
      "security",
      "privacy",
      "accessibility",
      "usability",
      "visual",
      "maintainability",
      "compatibility",
      "operability",
      "cost",
      "sustainability",
      "other",
    ]),
    statement: z.string().min(1),
    /** The observable threshold or boundary that makes the quality claim testable. */
    target: z.string().min(1),
    priority: z.enum(["must", "should", "could"]).default("must"),
    criteria: z.array(acceptanceCriterionSchema).default([]),
  })
  .strict();

export type QualityRequirement = z.infer<typeof qualityRequirementSchema>;

export const behaviorScenarioSchema = z
  .object({
    id: scenarioIdSchema,
    title: z.string().min(1),
    given: z.array(z.string().min(1)).min(1),
    when: z.string().min(1),
    expected: z.array(z.string().min(1)).min(1),
    requirements: z.array(engineeringReferenceSchema).min(1),
    /** Acceptance criteria whose executable evidence settles this scenario. */
    criteria: z.array(criterionIdSchema).min(1).optional(),
  })
  .strict();

export type BehaviorScenario = z.infer<typeof behaviorScenarioSchema>;

/** What the change must do. Draft stages leave `draft: true` until validated. */
export const specSchema = z
  .object({
    ...artifactEnvelope("spec"),
    feature: featureIdSchema,
    summary: z.string().default(""),
    /** Explicit visible-output decisions carried through implementation and critique. */
    designBrief: designBriefSchema.optional(),
    requirements: z.array(requirementSchema).default([]),
    /** Research inputs consciously accepted into this contract. */
    researchFindings: z.array(researchFindingIdSchema).default([]),
    qualityRequirements: z.array(qualityRequirementSchema).default([]),
    behaviorScenarios: z.array(behaviorScenarioSchema).default([]),
    outOfScope: z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
  })
  .strict();

export type Spec = z.infer<typeof specSchema>;

export const decisionSchema = z
  .object({
    statement: z.string().min(1),
    rationale: z.string().default(""),
  })
  .strict();

export const moduleBoundarySchema = z
  .object({
    name: z.string().min(1),
    /** Execution boundary for functional checks; HTML delivery paths also establish browser work. */
    runtime: verificationEnvironmentSchema.optional(),
    paths: z.array(pathPatternSchema).min(1),
    responsibility: z.string().min(1),
    owns: z.array(z.string().min(1)).default([]),
    dependsOn: z.array(z.string().min(1)).default([]),
    publicInterfaces: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const testStrategyEntrySchema = z
  .object({
    layer: validationLayerSchema,
    covers: z.array(engineeringReferenceSchema).min(1),
    approach: z.string().min(1),
  })
  .strict();

/** How the change will be made. */
export const planSchema = z
  .object({
    ...artifactEnvelope("plan"),
    feature: featureIdSchema,
    approach: z.string().default(""),
    /** Research inputs consciously accepted into this design. */
    researchFindings: z.array(researchFindingIdSchema).default([]),
    decisions: z.array(decisionSchema).default([]),
    modules: z.array(moduleBoundarySchema).default([]),
    invariants: z.array(z.string().min(1)).default([]),
    testStrategy: z.array(testStrategyEntrySchema).default([]),
    risks: z.array(z.string()).default([]),
    /** Dependencies the change intends to add; anything else is unapproved. */
    newDependencies: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;

/** Requirement to task coverage, derived rather than authored. */
export const traceabilitySchema = z
  .object({
    ...artifactEnvelope("traceability"),
    feature: featureIdSchema,
    links: z
      .array(
        z
          .object({
            requirement: requirementIdSchema,
            tasks: z.array(taskIdSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    qualityLinks: z
      .array(
        z
          .object({
            requirement: qualityRequirementIdSchema,
            tasks: z.array(taskIdSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    scenarioLinks: z
      .array(
        z
          .object({
            scenario: scenarioIdSchema,
            tasks: z.array(taskIdSchema).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type Traceability = z.infer<typeof traceabilitySchema>;
