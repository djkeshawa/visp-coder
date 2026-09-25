import { isAbsolute } from "node:path";
import { z } from "zod";
import { taskRefSchema } from "../core/identity.js";
import { type FeedbackLoopSummary, feedbackLoopSchema } from "./loop-contracts.js";

export { type TaskRef, taskRefSchema } from "../core/identity.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath = z.string().min(1).refine(isAbsolute, "An absolute path is required");
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === ".." || part === "." || part === ""),
    "A normalized relative path is required",
  );
const toolRule = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => /^[A-Za-z*]/.test(value), "Tool rules must begin with a tool name")
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && code !== 0x7f;
      }),
    "Tool rules must not contain control characters",
  );
const commandArgument = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    "Command arguments must not contain control characters",
  );

export const runnerHostSchema = z.enum(["codex", "claude"]);
export type RunnerHost = z.infer<typeof runnerHostSchema>;

export const priceSnapshotSchema = z
  .object({
    source: z.string().min(1),
    capturedAt: z.string().datetime({ offset: true }),
    currency: z.literal("USD"),
    model: z.string().min(1),
    uncachedInputPerMillion: z.number().finite().nonnegative(),
    cachedInputPerMillion: z.number().finite().nonnegative(),
    cacheWriteInputPerMillion: z.number().finite().nonnegative(),
    outputPerMillion: z.number().finite().nonnegative(),
  })
  .strict();
export type PriceSnapshot = z.infer<typeof priceSnapshotSchema>;

export const assignmentSchema = z
  .object({
    study: id,
    scenario: id,
    repositoryGroup: id,
    arm: z.enum(["economical-baseline", "economical-visp", "strong-reference", "ablation"]),
    split: z.enum(["pilot", "confirmation", "learning"]),
    repetition: z.number().int().nonnegative(),
    order: z.number().int().nonnegative(),
  })
  .strict();
export type Assignment = z.infer<typeof assignmentSchema>;

export const runnerSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    id,
    repository: absolutePath,
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
    task: taskRefSchema,
    prompt: z.string().min(1).max(1_000_000),
    host: z
      .object({
        kind: runnerHostSchema,
        executable: absolutePath,
        executableSha256: digest,
        version: z.string().min(1),
        model: z.string().min(1),
        effort: z.string().min(1).optional(),
      })
      .strict(),
    permissions: z
      .object({
        mode: z.enum(["read-only", "workspace-write"]),
        requireSandbox: z.boolean(),
        allowedTools: z.array(toolRule).min(1).max(256).optional(),
      })
      .strict(),
    budget: z
      .object({
        maxDurationMs: z.number().int().positive().max(86_400_000),
        maxEstimatedUsd: z.number().finite().positive(),
        studyMaxEstimatedUsd: z.number().finite().positive(),
        studyApprovalId: id,
        monetaryEnforcement: z.enum(["estimated", "strict"]),
        prices: priceSnapshotSchema,
      })
      .strict(),
    harness: z
      .object({
        mode: z.enum(["disabled", "visp"]),
        files: z.array(z.object({ path: relativePath, sha256: digest }).strict()),
        requiredTools: z.array(z.string().min(1)),
        requiredHooks: z.array(z.string().min(1)),
        requiredCommands: z.array(z.array(commandArgument).min(1).max(256)).max(64).optional(),
      })
      .strict(),
    assignment: assignmentSchema,
    feedbackLoop: feedbackLoopSchema.optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (
      spec.feedbackLoop &&
      (spec.permissions.mode !== "workspace-write" ||
        spec.feedbackLoop.reviewMaxDurationMs >= spec.budget.maxDurationMs)
    )
      ctx.addIssue({
        code: "custom",
        path: ["feedbackLoop"],
        message: "The loop needs a writable actor and time reserved for both actor and reviewer",
      });
    if (spec.budget.maxEstimatedUsd > spec.budget.studyMaxEstimatedUsd) {
      ctx.addIssue({
        code: "custom",
        message: "Attempt maximum must not exceed the approved study maximum",
        path: ["budget", "maxEstimatedUsd"],
      });
    }
    if (spec.budget.prices.model !== spec.host.model) {
      ctx.addIssue({
        code: "custom",
        message: "Price snapshot must name the pinned model",
        path: ["budget", "prices"],
      });
    }
    validateHarnessRequirements(spec.harness, ctx);
    if (
      spec.host.kind === "claude" &&
      spec.permissions.mode === "read-only" &&
      spec.harness.requiredCommands?.length
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Read-only Claude runs cannot declare command requirements because Bash is unavailable",
        path: ["harness", "requiredCommands"],
      });
    if (spec.host.kind === "codex" && spec.permissions.allowedTools !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "allowedTools is supported only for Claude hosts",
        path: ["permissions", "allowedTools"],
      });
    }
    if (spec.permissions.mode === "read-only" && spec.permissions.allowedTools) {
      const readOnlyTools = new Set(["Read", "Glob", "Grep"]);
      if (spec.permissions.allowedTools.some((tool) => !readOnlyTools.has(tool)))
        ctx.addIssue({
          code: "custom",
          message: "Read-only allowedTools may contain only Read, Glob, and Grep",
          path: ["permissions", "allowedTools"],
        });
    }
  });
export type RunnerSpec = z.infer<typeof runnerSpecSchema>;

function validateHarnessRequirements(
  harness: {
    mode: "disabled" | "visp";
    files: readonly unknown[];
    requiredTools: readonly string[];
    requiredHooks: readonly string[];
    requiredCommands?: readonly (readonly string[])[];
  },
  ctx: z.RefinementCtx,
): void {
  const requiredCommands = harness.requiredCommands ?? [];
  const missingVispRequirement =
    !harness.files.length || (!harness.requiredTools.length && !requiredCommands.length);
  if (harness.mode === "visp" && missingVispRequirement)
    ctx.addIssue({
      code: "custom",
      message:
        "VISP runs require pinned harness files and at least one tool or command requirement",
      path: ["harness"],
    });
  const disabledHasRequirements =
    harness.files.length ||
    harness.requiredTools.length ||
    harness.requiredHooks.length ||
    requiredCommands.length;
  if (harness.mode === "disabled" && disabledHasRequirements)
    ctx.addIssue({
      code: "custom",
      message: "Disabled harness must not declare VISP requirements",
      path: ["harness"],
    });
}

export interface NormalizedUsage {
  readonly model: string;
  /** Inclusive of cache reads and writes, unlike Anthropic's input_tokens. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  /** A subset of outputTokens; null means the host did not report it. */
  readonly reasoningTokens: number | null;
}

export interface AdapterCapabilities {
  readonly monetaryEnforcement: "estimated" | "host-estimated";
  readonly sandbox: "host-requested" | "unavailable";
  readonly instructionLoading: "unobservable";
  readonly hookEvents: boolean;
  readonly resume: boolean;
}

export interface HostEvent {
  readonly type: "started" | "progress" | "completed" | "failed";
  readonly sessionId?: string;
  readonly usage?: readonly NormalizedUsage[];
  readonly estimatedUsd?: number;
  readonly observedTools?: readonly string[];
  readonly observedHooks?: readonly string[];
  readonly reportedModel?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name?: string;
    readonly outcome: "started" | "completed" | "failed";
  }[];
  readonly commandCalls?: readonly {
    readonly id: string;
    readonly argv?: readonly string[];
    readonly outcome: "started" | "completed" | "failed";
  }[];
}

export type RunnerStatus = "completed" | "failed" | "cancelled" | "timed-out" | "budget-exceeded";

export interface RunnerResult {
  readonly feedbackLoop?: FeedbackLoopSummary;
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly manifestHash: string;
  readonly status: RunnerStatus;
  readonly exitCode: number | null;
  readonly sessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly eventCount: number;
  readonly eventHead: string;
  readonly snapshotHash: string;
  readonly usage: readonly NormalizedUsage[];
  readonly estimatedUsd: number | null;
  readonly actualBilledUsd: null;
  readonly diagnostics: readonly string[];
  readonly provenance: "local-runner";
}
