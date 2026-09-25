/** Historical task graph records, still read by migration and the legacy readers. */
import { z } from "zod";
import {
  artifactEnvelope,
  commandSpecSchema,
  featureIdSchema,
  pathPatternSchema,
  qualityRequirementIdSchema,
  requirementIdSchema,
  riskLevelSchema,
  scenarioIdSchema,
  taskClassSchema,
  taskIdSchema,
  taskStatusSchema,
  validationLayerSchema,
} from "./common.js";

/** Historical read-only probe perspectives; retained so recorded task graphs still parse. */
const probeRoleSchema = z.enum(["impact", "risk", "test", "visual"]);

export const validationCheckSchema = z
  .object({
    layer: validationLayerSchema,
    command: commandSpecSchema,
  })
  .strict();

export type ValidationCheck = z.infer<typeof validationCheckSchema>;

/**
 * Engineering shapes that determine evidence needs. These are deliberately
 * domain-neutral: a task declares the boundary it changes instead of Visp
 * guessing from words in its title or acceptance criteria.
 */
export const engineeringConcernSchema = z.enum([
  "custom-logic",
  "cross-boundary",
  "user-interaction",
  "visible-output",
  "visual-quality",
  "high-uncertainty",
]);
export type EngineeringConcern = z.infer<typeof engineeringConcernSchema>;

/**
 * A unit of work with its file scope declared up front. `allowedFiles` is what
 * the agent may write; `expectedFiles` is what a complete change should touch;
 * `forbiddenFiles` wins over both.
 */
export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().min(1),
    description: z.string().default(""),
    taskClass: taskClassSchema.default("feature"),
    riskLevel: riskLevelSchema.default("low"),
    status: taskStatusSchema.default("pending"),
    requirements: z.array(requirementIdSchema).default([]),
    qualityRequirements: z.array(qualityRequirementIdSchema).default([]),
    scenarios: z.array(scenarioIdSchema).default([]),
    /** Module boundaries from plan.json this task owns or changes. */
    modules: z.array(z.string().min(1)).default([]),
    /** Explicit evidence-driving concerns; absence means no concern was declared. */
    concerns: z.array(engineeringConcernSchema).optional(),
    dependsOn: z.array(taskIdSchema).default([]),
    allowedFiles: z.array(pathPatternSchema).default([]),
    expectedFiles: z.array(pathPatternSchema).default([]),
    forbiddenFiles: z.array(pathPatternSchema).default([]),
    /** Commands that prove this task works. Run as argv, never through a shell. */
    validationCommands: z.array(commandSpecSchema).default([]),
    /** Layered checks. Optional so existing task artifacts remain valid. */
    validationChecks: z.array(validationCheckSchema).optional(),
    /** Test runners, fixtures, and other validation support kept current during a flip. */
    validationFiles: z.array(pathPatternSchema).default([]),
    /** Independent read-only perspectives required before review can pass. */
    probeRoles: z.array(probeRoleSchema).default([]),
    doneCriteria: z.array(z.string()).default([]),
  })
  .strict();

export type Task = z.infer<typeof taskSchema>;

/** All task-owned validation, with legacy commands left deliberately unclassified. */
export function validationChecksFor(task: Task): Array<{
  command: z.infer<typeof commandSpecSchema>;
  layer?: z.infer<typeof validationLayerSchema>;
}> {
  return [
    ...(task.validationChecks ?? []),
    ...task.validationCommands.map((command) => ({ command })),
  ];
}

export const taskGraphSchema = z
  .object({
    ...artifactEnvelope("tasks"),
    feature: featureIdSchema,
    tasks: z.array(taskSchema).default([]),
    draft: z.boolean().default(true),
  })
  .strict()
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const task of graph.tasks) {
      if (ids.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate task id: ${task.id}`,
          path: ["tasks"],
        });
      }
      ids.add(task.id);
    }

    for (const task of graph.tasks) {
      for (const dependency of task.dependsOn) {
        if (!ids.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${task.id} depends on unknown task ${dependency}`,
            path: ["tasks"],
          });
        }
        if (dependency === task.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${task.id} depends on itself`,
            path: ["tasks"],
          });
        }
      }
    }
  });

export type TaskGraph = z.infer<typeof taskGraphSchema>;

export function findTask(graph: TaskGraph, taskId: string): Task | undefined {
  return graph.tasks.find((task) => task.id === taskId);
}
