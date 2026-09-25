import { z } from "zod";
import { PRESETS, STAGES } from "../../core/constants.js";
import { artifactEnvelope, featureIdSchema, isoTimestampSchema, taskIdSchema } from "./common.js";

/** Detected facts about the repository, written once at init and refreshed by scan. */
export const projectSchema = z
  .object({
    ...artifactEnvelope("project"),
    name: z.string().min(1),
    preset: z.enum(PRESETS),
    languages: z.array(z.string()).default([]),
    packageManager: z.string().optional(),
    hasGit: z.boolean(),
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;

/** Which feature and task are active, and what ran last. */
export const statusSchema = z
  .object({
    ...artifactEnvelope("status"),
    activeFeature: featureIdSchema.optional(),
    activeTask: taskIdSchema.optional(),
    stage: z.enum(STAGES).optional(),
    lastCommand: z.string().optional(),
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type Status = z.infer<typeof statusSchema>;

export function emptyStatus(createdAt: string): Status {
  return { kind: "status", createdAt, updatedAt: createdAt };
}
