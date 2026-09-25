import { z } from "zod";
import { behaviorScenarioSchema, qualityRequirementSchema, requirementSchema } from "./feature.js";
import { taskSchema } from "./tasks.js";

/** Exact evidence obligations saved at authorization, so amendments can preserve them. */
export const engineeringContractSchema = z
  .object({
    requirements: z.array(requirementSchema),
    qualityRequirements: z.array(qualityRequirementSchema),
    behaviorScenarios: z.array(behaviorScenarioSchema),
    task: taskSchema.pick({
      taskClass: true,
      riskLevel: true,
      requirements: true,
      qualityRequirements: true,
      scenarios: true,
      concerns: true,
      validationCommands: true,
      validationChecks: true,
      validationFiles: true,
      doneCriteria: true,
    }),
  })
  .strict();
