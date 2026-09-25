import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fromUnknown, vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { runSupervisedControl, type SupervisedControl } from "../../testing/supervised-control.js";
import type { ProductSlice } from "../product/model.js";
import { withProductMutation } from "../product/runtime.js";
import { selectProductSlice } from "../product/scopes.js";
import {
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
} from "../product/store.js";
import { productContractDigest, productSourceDigest } from "../product/subject.js";
import type { WorkspaceState } from "../state.js";

const subject = z
  .object({ directory: z.string().min(1), files: z.array(z.string().min(1)).min(1).max(500) })
  .strict();
export const controlExperimentSchema = z
  .object({
    outcomes: z.array(z.string().min(1)).min(1),
    baseline: subject,
    changed: subject,
    // Homogeneous items keep the MCP schema usable by hosts that reject tuple schemas.
    loadCommand: z
      .array(z.string())
      .nonempty()
      .refine(([command]) => command !== undefined && command.length > 0, {
        message: "Command executable must not be empty",
        path: [0],
      }),
    verifierFile: z.string().min(1),
    executable: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  })
  .strict();

export async function runProductControl(
  workspace: WorkspaceState,
  options: ProductSelection & { readonly experiment: unknown },
): Promise<Result<{ id: string; detected: boolean; execution: SupervisedControl }>> {
  const experiment = controlExperimentSchema.safeParse(options.experiment);
  if (!experiment.success)
    return err(
      vispError("CONFIG_INVALID", `Invalid control experiment: ${experiment.error.message}`),
    );
  return withProductMutation(workspace, async () => {
    const record = await readProductRecord(workspace, options);
    if (!record.ok) return record;
    const slice = selectProductSlice(workspace, record.value, options);
    if (!slice.ok) return slice;
    if (!outcomesExist(record.value, experiment.data.outcomes))
      return err(vispError("CONFIG_INVALID", "Control experiment references an unknown outcome"));
    const before = await productSourceDigest(workspace, record.value.brief);
    if (!before.ok) return before;
    return executeProductControl(
      workspace,
      record.value,
      slice.value,
      experiment.data,
      before.value,
    );
  });
}

async function executeProductControl(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  experiment: z.infer<typeof controlExperimentSchema>,
  subjectDigest: string,
): Promise<Result<{ id: string; detected: boolean; execution: SupervisedControl }>> {
  try {
    const confined = await confinedControlInputs(workspace, experiment);
    if (!confined.ok) return confined;
    const execution = await runSupervisedControl({
      ...experiment,
      baseline: {
        ...experiment.baseline,
        directory: workspace.paths.absolute(experiment.baseline.directory),
      },
      changed: {
        ...experiment.changed,
        directory: workspace.paths.absolute(experiment.changed.directory),
      },
      verifierFile: workspace.paths.absolute(experiment.verifierFile),
    });
    const after = await productSourceDigest(workspace, record.brief);
    if (!after.ok) return after;
    if (after.value !== subjectDigest)
      return err(vispError("EVIDENCE_FAILED", "Product changed while the control experiment ran"));
    return publishControl(
      workspace,
      record,
      execution,
      experiment.outcomes,
      subjectDigest,
      productContractDigest(record.brief, slice),
      slice?.id,
    );
  } catch (cause) {
    return err(fromUnknown(cause, "EVIDENCE_FAILED"));
  }
}

function outcomesExist(record: ProductRecord, outcomes: readonly string[]): boolean {
  return outcomes.every((id) => record.brief.outcomes.some((outcome) => outcome.id === id));
}
async function publishControl(
  workspace: WorkspaceState,
  record: ProductRecord,
  execution: SupervisedControl,
  outcomes: string[],
  subjectDigest: string,
  contractDigest: string,
  task?: string,
): Promise<Result<{ id: string; detected: boolean; execution: SupervisedControl }>> {
  const id = `CTL-${randomUUID()}`;
  const receipt = {
    id,
    subjectDigest,
    contractDigest,
    ...(task ? { task } : {}),
    outcomes,
    createdAt: new Date().toISOString(),
    execution,
  };
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    updatedAt: receipt.createdAt,
    controls: [...record.state.controls, receipt],
  });
  return saved.ok ? ok({ id, detected: execution.detected, execution }) : saved;
}
async function confinedControlInputs(
  workspace: WorkspaceState,
  experiment: z.infer<typeof controlExperimentSchema>,
): Promise<Result<void>> {
  for (const path of [
    experiment.baseline.directory,
    experiment.changed.directory,
    experiment.verifierFile,
  ]) {
    const checked = await workspace.files.metadata(workspace.paths.absolute(path));
    if (!checked.ok) return checked;
    if (!checked.value) return err(vispError("ARTIFACT_MISSING", `Missing control input: ${path}`));
  }
  return ok(undefined);
}
