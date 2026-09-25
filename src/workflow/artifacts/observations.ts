import { z } from "zod";
import {
  artifactEnvelope,
  criterionIdSchema,
  featureIdSchema,
  requirementReferenceSchema,
  sha256Schema,
  taskIdSchema,
} from "./common.js";

const observationPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/"), "Path must be repository-relative")
  .refine(
    (value) => !value.replace(/\\/g, "/").split("/").includes(".."),
    "Path must not escape the repository",
  );

export const observationSourceSchema = z.enum(["browser", "manual"]);

export const observationResultSchema = z.enum(["satisfied", "failed", "unclear"]);

export const observationImageDimensionsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

export const observationCaptureSchema = z.enum(["viewport", "full-page"]);
export type ObservationCapture = z.infer<typeof observationCaptureSchema>;

export const observationAttachmentSchema = z
  .object({
    /** The project-relative path supplied by the observer. */
    sourcePath: observationPathSchema,
    /** The project-relative immutable copy owned by this receipt. */
    storedPath: observationPathSchema,
    sha256: sha256Schema,
    /** Pixel dimensions read from the copied image bytes, never self-reported. */
    dimensions: observationImageDimensionsSchema.optional(),
  })
  .strict();

export type ObservationAttachment = z.infer<typeof observationAttachmentSchema>;

export const observationViewportSchema = z
  .object({
    width: z.number().int().positive().max(16_384),
    height: z.number().int().positive().max(16_384),
  })
  .strict();

export type ObservationViewport = z.infer<typeof observationViewportSchema>;

export const observationEnvironmentSchema = z
  .object({
    /** Rendering engine or browser family, for example chromium or webkit. */
    browserEngine: z.string().trim().min(1).max(100).optional(),
    /** Runtime platform relevant to the observed state, for example linux or ios. */
    platform: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => value.browserEngine !== undefined || value.platform !== undefined,
    "Observation environment must name a browser engine or platform",
  );

export type ObservationEnvironment = z.infer<typeof observationEnvironmentSchema>;

/**
 * A human or browser observation is context, not verification. Its contract
 * hashes let later readers say whether it still describes the artifacts under
 * review without promoting the observation into mechanical evidence.
 */
export const observationReceiptSchema = z
  .object({
    ...artifactEnvelope("observation"),
    id: z.string().regex(/^OBS-[0-9a-f]{12}$/),
    /** Missing means legacy v1; never rewrite historical receipt identities. */
    identityVersion: z.literal(2).optional(),
    feature: featureIdSchema,
    task: taskIdSchema,
    requirement: requirementReferenceSchema,
    criterion: criterionIdSchema,
    criterionStatement: z.string().min(1),
    source: observationSourceSchema,
    result: observationResultSchema,
    note: z.string().min(1).max(4_000),
    /** Browser reproduction context. Optional only for legacy/manual receipts. */
    viewport: observationViewportSchema.optional(),
    /** Whether image height is expected to equal the viewport or cover the full page. */
    capture: observationCaptureSchema.optional(),
    route: z.string().min(1).optional(),
    steps: z.array(z.string().min(1)).default([]),
    /** Optional on legacy receipts and when the environment cannot be observed reliably. */
    environment: observationEnvironmentSchema.optional(),
    specHash: sha256Schema,
    contextManifestHash: sha256Schema,
    /**
     * Stable digest of the owned criterion, selected context content, and
     * reproduction state. Absent on receipts written before semantic
     * freshness was introduced.
     */
    subjectHash: sha256Schema.optional(),
    /** Digest of the selected source files' worktree bytes at capture time. */
    sourceHash: sha256Schema.optional(),
    attachments: z.array(observationAttachmentSchema).default([]),
  })
  .strict();

export type ObservationReceipt = z.infer<typeof observationReceiptSchema>;

/** One active receipt per criterion, source, and reproducible state for a task. */
export const observationLogSchema = z
  .object({
    ...artifactEnvelope("observations"),
    feature: featureIdSchema,
    task: taskIdSchema,
    observations: z.array(observationReceiptSchema).default([]),
  })
  .strict();

export type ObservationLog = z.infer<typeof observationLogSchema>;

export interface ObservationView extends ObservationReceipt {
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
}
