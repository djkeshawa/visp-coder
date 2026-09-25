import { isAbsolute } from "node:path";
import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().refine(isAbsolute, "An absolute path is required");
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const COMPARISON_ARMS = ["bare", "frozen-legacy", "replacement"] as const;
export const armSchema = z.enum(COMPARISON_ARMS);
const cohortSchema = z.enum(["existing-code-bug", "stateful-feature", "ui"]);
export const filePinSchema = z
  .object({
    path: z.string(),
    sha256: digest,
    bytes: z.number().int().nonnegative(),
    executable: z.boolean().optional(),
  })
  .strict();

export const comparisonSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    study: name,
    seed: z.string().min(1),
    model: z
      .object({
        host: z.enum(["codex", "claude"]),
        name: z.string().min(1),
        effort: z.string().min(1),
      })
      .strict(),
    tools: z
      .array(z.object({ name, executable: absolutePath, version: z.string().min(1) }).strict())
      .min(1),
    instructions: z
      .object({
        common: z.array(absolutePath),
        bare: z.array(absolutePath),
        "frozen-legacy": z.array(absolutePath),
        replacement: z.array(absolutePath),
      })
      .strict(),
    allowedTools: z.array(z.string().min(1)).min(1),
    customSkills: z.literal("disabled"),
    environment: z
      .object({
        locale: z.string().min(1),
        timezone: z.string().min(1),
        runtimeImage: z.string().min(1).optional(),
      })
      .strict(),
    legacy: z.object({ manifest: absolutePath, archive: absolutePath }).strict(),
    replacement: z
      .object({
        root: absolutePath,
        sourcePaths: z.array(z.string().min(1)).min(1),
        buildPath: z.string().min(1),
      })
      .strict(),
    tasks: z
      .array(
        z
          .object({
            id: name,
            cohort: cohortSchema,
            promptFile: absolutePath,
            startDirectory: absolutePath,
            oracleDirectory: absolutePath,
          })
          .strict(),
      )
      .length(3),
  })
  .strict()
  .superRefine((spec, context) => {
    if (
      new Set(spec.tasks.map((task) => task.id)).size !== 3 ||
      new Set(spec.tasks.map((task) => task.cohort)).size !== 3
    ) {
      context.addIssue({
        code: "custom",
        path: ["tasks"],
        message: "Provide three distinct tasks, one per cohort",
      });
    }
    if (new Set(spec.tools.map((tool) => tool.name)).size !== spec.tools.length) {
      context.addIssue({ code: "custom", path: ["tools"], message: "Tool names must be unique" });
    }
  });
export type ComparisonSpec = z.infer<typeof comparisonSpecSchema>;

export const baselineSchema = z
  .object({
    createdAt: z.string(),
    head: z.string(),
    status: z.string(),
    files: z.array(filePinSchema).min(1),
  })
  .strict();

export interface TreePin {
  readonly sha256: string;
  readonly files: readonly z.infer<typeof filePinSchema>[];
}
export interface Assignment {
  readonly id: string;
  readonly task: string;
  readonly arm: z.infer<typeof armSchema>;
  readonly repetition: number;
  readonly order: number;
}
export interface PreparedComparison {
  readonly schemaVersion: 1;
  readonly kind: "prepared-product-comparison";
  readonly study: string;
  readonly seed: string;
  readonly status: "prepared-awaiting-budget";
  readonly runnable: false;
  readonly budget: null;
  readonly repetitions: 3;
  readonly policy: typeof COMPARISON_POLICY;
  readonly model: ComparisonSpec["model"];
  readonly tools: readonly {
    readonly name: string;
    readonly version: string;
    readonly executable: string;
    readonly sha256: string;
  }[];
  readonly allowedTools: readonly string[];
  readonly customSkills: "disabled";
  readonly environment: ComparisonSpec["environment"] & {
    readonly platform: string;
    readonly arch: string;
    readonly osRelease: string;
    readonly nodeVersion: string;
  };
  readonly instructions: Readonly<
    Record<"common" | z.infer<typeof armSchema>, readonly z.infer<typeof filePinSchema>[]>
  >;
  readonly legacy: {
    readonly manifest: z.infer<typeof baselineSchema>;
    readonly manifestSha256: string;
    readonly archiveSha256: string;
    readonly sourceSha256: string;
    readonly buildSha256: string;
    readonly archiveMapping: "manifest-recorded";
  };
  readonly replacement: { readonly source: TreePin; readonly build: TreePin };
  readonly tasks: readonly {
    readonly id: string;
    readonly cohort: z.infer<typeof cohortSchema>;
    readonly prompt: string;
    readonly promptSha256: string;
    readonly start: TreePin;
    readonly oracle: TreePin;
  }[];
  readonly assignments: readonly Assignment[];
}

export const COMPARISON_POLICY = {
  name: "product-quality-first-pilot-v1",
  primary: ["correctness", "briefFidelity", "usability", "visualQuality", "severeDefects"],
  secondary: [
    "timeToFirstUsableMs",
    "durationMs",
    "modelUsd",
    "inputTokens",
    "outputTokens",
    "reviewCycles",
    "administrativeRepairs",
  ],
  promotion: "none-descriptive-pilot-only",
  evaluator: "held-out-expectations-and-blinded-experience-review",
  assessmentTrust: "externally-reported-not-attested",
} as const;

const nullableCount = z.number().int().nonnegative().nullable();
const nullableMeasure = z.number().finite().nonnegative().nullable();
const capabilitySignalSchema = z
  .object({
    capability: z.enum(["graph", "memory", "browser", "review"]),
    relevantInput: z.boolean(),
    invoked: z.boolean(),
    decisionChange: z
      .object({
        before: z.string().trim().min(1),
        after: z.string().trim().min(1),
        evidence: z.array(z.string().trim().min(1)).min(1).max(12),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((signal, context) => {
    if (
      signal.decisionChange &&
      (!signal.relevantInput ||
        !signal.invoked ||
        signal.decisionChange.before === signal.decisionChange.after)
    )
      context.addIssue({
        code: "custom",
        message:
          "A reported decision change needs relevant input, actual use, and distinct before/after decisions",
      });
  });
export const comparisonObservationSchema = z
  .object({
    assignmentId: z.string().min(1),
    status: z.enum(["completed", "failed", "timed-out", "cancelled", "environment-failed"]),
    capabilitySignals: z.array(capabilitySignalSchema).max(4).optional(),
    loop: z
      .object({
        firstPassCorrectness: z.number().min(0).max(1).nullable(),
        repairedCorrectness: z.number().min(0).max(1).nullable(),
        completedCorrections: nullableCount,
      })
      .strict()
      .optional(),
    assessment: z
      .object({ evaluatorId: z.string().min(1), evidenceSha256: digest, blinded: z.boolean() })
      .strict()
      .nullable(),
    quality: z
      .object({
        correctness: z.number().min(0).max(1).nullable(),
        briefFidelity: z.number().min(0).max(1).nullable(),
        usability: z.number().min(0).max(4).nullable(),
        visualQuality: z.number().min(0).max(4).nullable(),
        severeDefects: nullableCount,
      })
      .strict(),
    secondary: z
      .object({
        timeToFirstUsableMs: nullableMeasure,
        durationMs: nullableMeasure,
        modelUsd: nullableMeasure,
        inputTokens: nullableCount,
        outputTokens: nullableCount,
        reviewCycles: nullableCount,
        administrativeRepairs: nullableCount,
      })
      .strict(),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      row.capabilitySignals &&
      new Set(row.capabilitySignals.map((signal) => signal.capability)).size !==
        row.capabilitySignals.length
    )
      context.addIssue({
        code: "custom",
        path: ["capabilitySignals"],
        message: "Report each capability once per run",
      });
    if (
      !row.assessment &&
      row.loop &&
      (row.loop.firstPassCorrectness !== null || row.loop.repairedCorrectness !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["loop"],
        message: "First-pass and repaired scores require evaluator provenance",
      });
    if (!row.assessment && Object.values(row.quality).some((value) => value !== null))
      context.addIssue({
        code: "custom",
        path: ["assessment"],
        message: "Scored quality requires recorded evaluator provenance",
      });
    if (
      row.secondary.timeToFirstUsableMs !== null &&
      row.secondary.durationMs !== null &&
      row.secondary.timeToFirstUsableMs > row.secondary.durationMs
    )
      context.addIssue({
        code: "custom",
        path: ["secondary"],
        message: "First usable time cannot exceed total duration",
      });
  });
export type ComparisonObservation = z.infer<typeof comparisonObservationSchema>;
