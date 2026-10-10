import { z } from "zod";
import { STAGES } from "../../core/constants.js";
import { artifactEnvelope, featureIdSchema, isoTimestampSchema, taskIdSchema } from "./common.js";

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
