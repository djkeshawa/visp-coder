import { vispError } from "../../core/errors.js";
import { parseFeatureId, parseTaskId } from "../../core/input.js";
import { err, ok, type Result } from "../../core/result.js";
import { criterionIdSchema } from "../artifacts/common.js";
import { type ProductReviewBundle, runProductReview } from "../product/review.js";
import { hasProductFeature } from "../product/status.js";
import type { ProductSelection } from "../product/store.js";
import type { WorkspaceState } from "../state.js";
import { type ObservationBundle, observationBundle } from "./observation-delivery.js";
import { resolveLegacyTask } from "./task-selection.js";

export type ObservationsRead =
  | { workflow: "product"; bundle: ProductReviewBundle }
  | { workflow: "historical"; bundle: ObservationBundle };

type ObservationSelection = ProductSelection & {
  feature: string;
  outcome?: string;
  criterion?: string;
};
/** Read the same current product review context, retaining the immutable legacy image reader. */
export async function readObservations(
  workspace: WorkspaceState,
  options: ObservationSelection,
): Promise<Result<ObservationsRead>> {
  const selection = validateSelection(options);
  if (!selection.ok) return selection;
  if (options.criterion === undefined && (await hasProductFeature(workspace, options.feature))) {
    const result = await runProductReview(workspace, options);
    if (!result.ok) return result;
    const selected = options.outcome;
    if (selected && !result.value.outcomes.some((outcome) => outcome.id === selected))
      return err(
        vispError(
          "CONFIG_INVALID",
          `Outcome ${selected} is not part of the selected product scope`,
        ),
      );
    return ok({ workflow: "product", bundle: result.value });
  }
  if (!criterionIdSchema.safeParse(options.criterion).success)
    return err(vispError("CONFIG_INVALID", "Historical observations require a valid --criterion"));
  const task = await resolveLegacyTask(workspace, options.feature, options.task);
  if (!task.ok) return task;
  const bundle = await observationBundle(
    workspace,
    options.feature,
    options.criterion as string,
    task.value?.id,
  );
  return bundle.ok ? ok({ workflow: "historical", bundle: bundle.value }) : bundle;
}

function validateSelection(options: ObservationSelection): Result<void> {
  const feature = parseFeatureId(options.feature);
  if (!feature.ok) return feature;
  if (options.task !== undefined) {
    const task = parseTaskId(options.task);
    if (!task.ok) return task;
  }
  if (options.criterion !== undefined && options.outcome !== undefined)
    return err(
      vispError("CONFIG_INVALID", "Choose a product outcome or a historical criterion, not both"),
    );
  return ok(undefined);
}
