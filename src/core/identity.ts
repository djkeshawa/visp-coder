import { z } from "zod";
import { featureIdSchema, taskIdSchema } from "./input.js";

export const taskRefSchema = z.object({ feature: featureIdSchema, task: taskIdSchema }).strict();
export type TaskRef = z.infer<typeof taskRefSchema>;

/** Unambiguous identity; task IDs are unique only within their feature. */
export function taskRefKey(ref: TaskRef): string {
  return JSON.stringify([ref.feature, ref.task]);
}
