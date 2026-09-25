import { z } from "zod";
import { STAGES, STRICTNESS_MODES } from "../../core/constants.js";
import {
  artifactEnvelope,
  featureIdSchema,
  isoTimestampSchema,
  taskIdSchema,
} from "../artifacts/common.js";
import { RULE_IDS } from "./rules.js";

const ruleIdSchema = z.enum(RULE_IDS);

/**
 * `policy.json` records only what the project chose: the strictness mode and any
 * deliberate deviation from that mode's defaults.
 */
export const policySchema = z
  .object({
    ...artifactEnvelope("policy"),
    strictness: z.enum(STRICTNESS_MODES),
    /**
     * Explicit on/off decisions that override the strictness defaults.
     *
     * Keyed by any string, not by the current rule ids. A retired or renamed
     * rule would otherwise fail this schema, and because every command loads
     * the policy first, one stale key made the whole project unusable — with a
     * zod dump rather than an explanation. A decision naming a rule that no
     * longer exists is stale, not corrupt: `resolveRule` ignores it and
     * `policy validate` reports it.
     */
    rules: z.record(z.string(), z.boolean()).default({}),
    maxChangedFiles: z.number().int().positive().optional(),
  })
  .strict();

export type Policy = z.infer<typeof policySchema>;

/**
 * A recorded, expiring exception to one rule. An override says who allowed what,
 * where, and why — an unexplained exception is not an exception, it is a hole.
 */
export const overrideSchema = z
  .object({
    id: z.string().min(1),
    rule: ruleIdSchema,
    reason: z.string().min(10, "An override needs a reason someone can evaluate later"),
    scope: z
      .object({
        feature: featureIdSchema.optional(),
        task: taskIdSchema.optional(),
        stage: z.enum(STAGES).optional(),
      })
      .strict()
      .default({}),
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    revokedAt: isoTimestampSchema.optional(),
  })
  .strict();

export type Override = z.infer<typeof overrideSchema>;

export const overrideStoreSchema = z
  .object({
    ...artifactEnvelope("overrides"),
    overrides: z.array(overrideSchema).default([]),
  })
  .strict();

export type OverrideStore = z.infer<typeof overrideStoreSchema>;
