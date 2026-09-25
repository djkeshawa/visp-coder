import { z } from "zod";
import {
  artifactEnvelope,
  criterionIdSchema,
  featureIdSchema,
  isoTimestampSchema,
  pathPatternSchema,
  requirementReferenceSchema,
  sha256Schema,
  taskIdSchema,
  validationLayerSchema,
} from "./common.js";
import { engineeringContractSchema } from "./contract.js";
import { evidenceReceiptSchema } from "./evidence-contract.js";

/**
 * Whether the commands that would prove a change actually ran.
 * `refused` means none could run and `partial` means some could not. Neither is
 * ever treated as a pass: a check that did not happen proves nothing, however
 * many of its neighbours did.
 */
export const codeEvidenceSchema = z.enum(["executed", "partial", "refused", "delegated"]);
export type CodeEvidence = z.infer<typeof codeEvidenceSchema>;

export const commandResultSchema = z
  .object({
    command: z.string(),
    exitCode: z.number().int(),
    passed: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    failureKind: z
      .enum([
        "invalid-command",
        "spawn",
        "timeout",
        "exit",
        "assertion",
        "no-tests",
        "invalid-report",
        "flaky-tests",
      ])
      .optional(),
    testSummary: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        flaky: z.number().int().nonnegative().optional(),
        errors: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    /** Present when useful to diagnose a failure, and truncated. */
    output: z.string().optional(),
    /** Machine-readable criterion assertions parsed from command output. */
    assertedCriteria: z
      .array(
        z
          .object({
            criterion: criterionIdSchema,
            outcome: z.enum(["passed", "failed"]),
          })
          .strict(),
      )
      .optional(),
    evidenceReceipts: z.array(evidenceReceiptSchema).max(256).optional(),
    /** Evidence boundary declared by the task, absent for legacy commands. */
    verificationLayer: validationLayerSchema.optional(),
    evidenceRole: z.literal("acceptance").optional(),
  })
  .strict();

export type CommandResult = z.infer<typeof commandResultSchema>;

export const findingSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    path: z.string().optional(),
    recommendation: z.string().optional(),
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

/** Exact code and contract state to which a verification or review applies. */
export const evidenceSubjectSchema = z
  .object({
    digest: sha256Schema,
    basis: z.enum(["working-tree", "staged", "ref"]),
    reference: z.string().optional(),
    head: z.string().min(1).optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
            digest: sha256Schema.optional(),
          })
          .strict(),
      )
      .default([]),
    contractHash: sha256Schema.optional(),
    contextManifestHash: sha256Schema.optional(),
    /** Stable semantic observation/probe input used only for retry reset. */
    evidenceHash: sha256Schema.optional(),
    validationHash: sha256Schema,
  })
  .strict();

/**
 * Whether validation fails on a tree with this task's change reverted.
 *
 * Absent means the check was not requested. `"not-applicable"` means the task
 * changed validation support but no implementation exists to revert.
 * `"unchecked"` means it was applicable but could not run — which is why a
 * reason is mandatory for both explicit states. The only positive signal a
 * gate may act on is `failsWithoutChange === true`.
 */
export const flipCheckSchema = z
  .object({
    failsWithoutChange: z.union([z.boolean(), z.literal("unchecked"), z.literal("not-applicable")]),
    /** What kind of failure the reverted tree produced, when it failed. */
    /** `behavioral` is retained for old receipts, not inferred from assertion output. */
    signal: z.enum(["behavioral", "structural", "unclassified"]).optional(),
    /** Why it could not run, did not apply, or how the reverted tree was built. */
    reason: z.string().optional(),
    revertedFiles: z.array(z.string()).default([]),
    preservedValidationFiles: z.array(z.string()).default([]),
    commands: z.array(commandResultSchema).default([]),
  })
  .strict()
  .superRefine((flip, ctx) => {
    if (
      (flip.failsWithoutChange === "unchecked" || flip.failsWithoutChange === "not-applicable") &&
      !flip.reason
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A "${flip.failsWithoutChange}" flip must say why`,
        path: ["reason"],
      });
    }
  });

/**
 * How one command's failures moved between attempts. A lens over the full
 * output, never a replacement for it — `commands[].output` stays complete.
 */
export const commandDeltaSchema = z
  .object({
    command: z.string(),
    /** Normalised failure lines that were not in the previous attempt. */
    newFailures: z.array(z.string()).default([]),
    persisting: z.number().int().nonnegative().default(0),
    resolved: z.number().int().nonnegative().default(0),
  })
  .strict();

export const verificationSchema = z
  .object({
    ...artifactEnvelope("verification"),
    feature: featureIdSchema,
    task: taskIdSchema.optional(),
    passed: z.boolean(),
    codeEvidence: codeEvidenceSchema,
    commands: z.array(commandResultSchema).default([]),
    changedFiles: z.array(z.string()).default([]),
    findings: z.array(findingSchema).default([]),
    /** Which verification of this task this is, counted from the previous record. */
    attempt: z.number().int().positive().optional(),
    /** Failure movement against the previous attempt, for commands run in both. */
    delta: z.array(commandDeltaSchema).optional(),
    /** Stable task/stage/input/failure identity used only for retry steering. */
    failureFingerprint: sha256Schema.optional(),
    flip: flipCheckSchema.optional(),
    /** Code, contract, and validation state this result actually attests to. */
    subject: evidenceSubjectSchema.optional(),
  })
  .strict();

export type Verification = z.infer<typeof verificationSchema>;

/**
 * What asking an acceptance criterion produced.
 *
 * Three values, because two would have to lie. `unchecked` is the honest answer
 * for a criterion whose verification is prose, or names a command that could not
 * be run: nothing was learned about it either way, and folding that into
 * `passed` would put a claim in the record that nothing supports.
 */
export const criterionOutcomeSchema = z.enum(["passed", "failed", "unchecked"]);

export const criterionCheckSchema = z
  .object({
    criterion: criterionIdSchema,
    requirement: requirementReferenceSchema,
    /** Carried so a reader of the evidence need not hold the spec open. */
    statement: z.string().min(1),
    outcome: criterionOutcomeSchema,
    /** The command that was run, absent when the criterion named none. */
    command: z.string().optional(),
    exitCode: z.number().int().optional(),
    /** Why it failed, or why it could not be checked. Truncated. */
    detail: z.string().optional(),
    /** Evidence boundary declared by the criterion. */
    verificationLayer: validationLayerSchema.optional(),
    /** The shared command explicitly named this criterion in its output. */
    assertionReceipt: z.boolean().optional(),
    evidenceReceipts: z.array(evidenceReceiptSchema).max(256).optional(),
  })
  .strict();

export type CriterionCheck = z.infer<typeof criterionCheckSchema>;

export const reviewSchema = z
  .object({
    ...artifactEnvelope("review"),
    feature: featureIdSchema,
    task: taskIdSchema.optional(),
    passed: z.boolean(),
    /** How the reviewed diff was obtained, so a pass cannot be misread. */
    basis: z.enum(["working-tree", "staged", "ref"]),
    reference: z.string().optional(),
    reviewedFiles: z.array(z.string()).default([]),
    /** Absent when the review was not scoped to a task, where they mean nothing. */
    expectedFilesSeen: z.array(z.string()).optional(),
    expectedFilesMissing: z.array(z.string()).optional(),
    /**
     * What each acceptance criterion in scope actually proved. An empty list
     * means none were in scope, never that they were satisfied — `passed` above
     * speaks for the findings, and an unchecked criterion raises none.
     */
    criteria: z.array(criterionCheckSchema).default([]),
    findings: z.array(findingSchema).default([]),
    /** Which review of this task this is. Absent on legacy records. */
    attempt: z.number().int().positive().optional(),
    /** Stable task/stage/input/failure identity used only for retry steering. */
    failureFingerprint: sha256Schema.optional(),
    /** Code, contract, and validation state this result actually attests to. */
    subject: evidenceSubjectSchema.optional(),
  })
  .strict();

export type Review = z.infer<typeof reviewSchema>;

export const featureEvidenceIssueSchema = z
  .object({
    task: taskIdSchema.optional(),
    stage: z.enum(["task", "verification", "review", "acceptance"]),
    code: z.string().min(1),
  })
  .strict();

const attemptFailureFingerprintSummarySchema = z
  .object({
    fingerprint: sha256Schema,
    count: z.number().int().positive(),
    firstCreatedAt: isoTimestampSchema,
    lastCreatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.firstCreatedAt > summary.lastCreatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "firstCreatedAt must not be later than lastCreatedAt",
        path: ["firstCreatedAt"],
      });
    }
  });

/** Complete history after combining retained receipts with compacted metadata. */
export const attemptHistorySummarySchema = z
  .object({
    task: taskIdSchema.optional(),
    stage: z.enum(["verification", "review"]),
    total: z.number().int().positive(),
    kept: z.number().int().nonnegative(),
    candidates: z.number().int().nonnegative(),
    compacted: z.number().int().nonnegative(),
    firstCreatedAt: isoTimestampSchema,
    lastCreatedAt: isoTimestampSchema,
    failureFingerprints: z.array(attemptFailureFingerprintSummarySchema).default([]),
  })
  .strict()
  .superRefine((history, context) => {
    if (history.firstCreatedAt > history.lastCreatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "firstCreatedAt must not be later than lastCreatedAt",
        path: ["firstCreatedAt"],
      });
    }
    if (history.total !== history.kept + history.compacted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "total must equal kept plus compacted attempts",
        path: ["total"],
      });
    }
    if (history.candidates > history.compacted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "candidates cannot exceed compacted attempts",
        path: ["candidates"],
      });
    }
    const seen = new Set<string>();
    let fingerprinted = 0;
    for (const [index, fingerprint] of history.failureFingerprints.entries()) {
      fingerprinted += fingerprint.count;
      if (seen.has(fingerprint.fingerprint)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "failure fingerprints must be unique within an attempt group",
          path: ["failureFingerprints", index, "fingerprint"],
        });
      }
      seen.add(fingerprint.fingerprint);
    }
    if (fingerprinted > history.total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failure fingerprint counts cannot exceed total attempts",
        path: ["failureFingerprints"],
      });
    }
  });

/** One canonical, machine-derived verdict shared by status and PR output. */
export const featureEvidenceSummarySchema = z
  .object({
    productAcceptance: z
      .object({
        status: z.enum(["pending", "passed", "failed", "stale"]),
        findings: z.array(findingSchema),
      })
      .strict()
      .optional(),
    /** Optional for legacy artifacts; workflow readiness alone is not acceptance. */
    completion: z
      .object({
        workflow: z.enum(["ready", "blocked"]),
        evidence: z.enum(["no-known-limitations", "limited", "unavailable"]),
        acceptance: z.enum(["checks-satisfied", "unresolved", "unassessed"]),
      })
      .strict()
      .optional(),
    ready: z.boolean(),
    totalTasks: z.number().int().nonnegative(),
    tasksDone: z.number().int().nonnegative(),
    verificationPassed: z.number().int().nonnegative(),
    reviewPassed: z.number().int().nonnegative(),
    /** Legacy field: passed tasks with no recorded evidence limitations, not semantic proof. */
    fullyEvidenced: z.number().int().nonnegative(),
    assessment: z
      .object({
        commandsExecuted: z.number().int().nonnegative(),
        criteriaPassed: z.number().int().nonnegative(),
        criteriaFailed: z.number().int().nonnegative(),
        criteriaUnchecked: z.number().int().nonnegative(),
        tasksWithLimitations: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    blockers: z.array(featureEvidenceIssueSchema).default([]),
    limitations: z.array(featureEvidenceIssueSchema).default([]),
    latestClosedTask: taskIdSchema.optional(),
    /** Optional so summaries embedded in older PR artifacts remain readable. */
    attemptHistory: z.array(attemptHistorySummarySchema).optional(),
  })
  .strict();

export const pullRequestSchema = z
  .object({
    ...artifactEnvelope("pr"),
    feature: featureIdSchema,
    title: z.string().min(1),
    body: z.string(),
    changedFiles: z.array(z.string()).default([]),
    checklist: z.array(z.string()).default([]),
    /** Optional so PR artifacts written by older Visp versions still parse. */
    summary: featureEvidenceSummarySchema.optional(),
  })
  .strict();

export type PullRequest = z.infer<typeof pullRequestSchema>;

/**
 * Authorization to edit a specific task's files. Written by `gate implement`,
 * read by the hooks, cleared when the task closes.
 */
export const implementMarkerSchema = z
  .object({
    ...artifactEnvelope("implement-marker"),
    feature: featureIdSchema,
    task: taskIdSchema,
    allowedFiles: z.array(pathPatternSchema).default([]),
    expectedFiles: z.array(pathPatternSchema).default([]),
    forbiddenFiles: z.array(pathPatternSchema).default([]),
    /** Requirements and validation semantics observed when implementation began. */
    contractHash: sha256Schema.optional(),
    /** Optional for legacy markers, which cannot safely support contract amendments. */
    contractSnapshot: engineeringContractSchema.optional(),
    /** Workflow mode and feature/task risk observed when implementation began. */
    workflowContractHash: sha256Schema.optional(),
    expiresAt: isoTimestampSchema.optional(),
  })
  .strict();

export type ImplementMarker = z.infer<typeof implementMarkerSchema>;
