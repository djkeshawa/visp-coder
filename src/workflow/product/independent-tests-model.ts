import { z } from "zod";
import type { Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import type { SessionActivity } from "./critic-exec.js";
import { disputeSchema } from "./pinned-dispute-model.js";
import { type RequestAmbiguity, requestAmbiguitySchema } from "./request-ambiguities.js";

/**
 * Independent acceptance tests. Before the first slice is authorized, a tester that never
 * sees the worker's code writes one executable test file from the original request alone.
 * VISP keeps it only when it has assertions and fails on the unimplemented project, then
 * pins it as protected intent: changing it needs an intent change the human reviewer sees.
 *
 * Why: frozen tests raise weak workers' correctness only when the tests are right, and
 * workers who write their own tests encode their own misreadings. Tests written from the
 * specification by a separate model and checked to fail first are the strongest available
 * signal a worker cannot quietly weaken (see docs/research-summary.md).
 */

export const TESTER_TIMEOUT_MS = 720_000;
export const BASELINE_TIMEOUT_MS = 120_000;

export const testerResponseSchema = z.object({
  file: z.object({ name: z.string(), content: z.string() }).nullable(),
  existingBehavior: z.boolean().default(false),
  tests: z.array(z.object({ name: z.string(), quote: z.string() })),
  ambiguities: z.array(requestAmbiguitySchema).default([]),
  notes: z.string(),
});

export type TesterResponse = z.infer<typeof testerResponseSchema>;

/** Codex structured output needs every property required and no extra properties. */
export const TESTER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["file", "existingBehavior", "tests", "ambiguities", "notes"],
  properties: {
    existingBehavior: { type: "boolean" },
    file: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["name", "content"],
          properties: { name: { type: "string" }, content: { type: "string" } },
        },
        { type: "null" },
      ],
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quote"],
        properties: { name: { type: "string" }, quote: { type: "string" } },
      },
    },
    notes: { type: "string" },
    ambiguities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["quote", "readings", "conventionalReading"],
        properties: {
          quote: { type: "string" },
          readings: { type: "array", items: { type: "string" }, minItems: 2 },
          conventionalReading: { type: "string" },
        },
      },
    },
  },
} as const;

export const independentTestsRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["running", "pinned", "rejected", "failed", "declined"]),
    startedAt: z.string(),
    /** The writing process; a host that ends it (Codex's sandbox does) leaves no result. */
    pid: z.number().int().optional(),
    /** The writer's pid namespace: a pid means nothing to a process in another one. */
    pidNamespace: z.string().optional(),
    finishedAt: z.string().optional(),
    model: z.string().optional(),
    reason: z.string().optional(),
    file: z.string().optional(),
    command: z.array(z.string()).optional(),
    tests: z.array(z.object({ name: z.string(), quote: z.string() })).optional(),
    ambiguities: z.array(requestAmbiguitySchema).optional(),
    /** Failing tests the worker disputed, and the independent reviewer's rulings. */
    disputes: z.array(disputeSchema).optional(),
    notes: z.string().optional(),
    content: z.string().optional(),
    sourceDigest: z.string().optional(),
    baseline: z
      .object({
        exitCode: z.number(),
        timedOut: z.boolean(),
        spawnFailed: z.boolean().optional(),
        output: z.string(),
      })
      .optional(),
  })
  .strict();

export type IndependentTestsRecord = z.infer<typeof independentTestsRecordSchema>;
/** The parts of a record one tester attempt decides. */
export type TestFields = Partial<IndependentTestsRecord>;

/** What `work` tells the worker about the pinned tests. */
export interface IndependentTestsSummary {
  readonly status: IndependentTestsRecord["status"] | "skipped";
  readonly file?: string;
  readonly command?: readonly string[];
  readonly reason?: string;
  readonly instructions?: string;
  readonly ambiguities?: readonly RequestAmbiguity[];
}

export interface TesterRequest {
  readonly root: string;
  /** Private launch-time source copy, never exposed to a new-project tester. */
  readonly sourceRoot?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly prompt: string;
  readonly schema: unknown;
  /** Work in a disposable writable copy where the existing program can be run. */
  readonly explore?: boolean;
  /** Paths left out of that copy (`workflow.blockedPaths`), besides common secret files. */
  readonly blockedPaths?: readonly string[];
  /** Receives the session's commands and web searches, for the human reviewer. */
  readonly onActivity?: (activity: SessionActivity) => void | Promise<void>;
}

/** Returns the tester's raw structured answer; throws when the tester could not run. */
export type IndependentTester = (request: TesterRequest) => Promise<unknown>;

/** Starts the tester for a feature and reports its record once finished or after `waitMs`. */
export type TestsStarter = ((
  workspace: WorkspaceState,
  feature: string,
  waitMs: number,
  /** Also restart a tester that failed, not only one that stopped without a result. */
  retryFailed?: boolean,
) => Promise<Result<IndependentTestsRecord>>) & {
  /** The tester runs inside the calling process, so that process must stay alive for it. */
  readonly inProcess?: true;
};

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function message(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 1200);
}
