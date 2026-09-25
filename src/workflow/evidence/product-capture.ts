import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import { criticRouteCommand } from "../product/critic-guidance.js";
import { supportedHostCaptureRecovery } from "../product/environment-model.js";
import { inspectProductImages } from "../product/images.js";
import { productObservationPlan } from "../product/observation-plan.js";
import { withProductMutation } from "../product/runtime.js";
import { selectProductSlice } from "../product/scopes.js";
import { type ProductNext, runProductNext } from "../product/status.js";
import { type ProductSelection, readProductRecord, saveProductState } from "../product/store.js";
import type { WorkspaceState } from "../state.js";
import { replayCommand, replayJourney } from "./capture-replay.js";
import {
  type ProductCaptureResult as ExecutedProductCaptureResult,
  withProductCapture,
} from "./product-capture-execution.js";

export type ProductCaptureResult = ExecutedProductCaptureResult & {
  /** The committed product state used to choose the next action. */
  readonly next?: ProductNext;
  /** Replays the exact persisted journey, including its original scope. */
  readonly replayCommand?: string;
};

/** Atomic capture publication is separate from reviewer assessments and refinement attempts. */
export async function runProductCapture(
  workspace: WorkspaceState,
  options: ProductSelection & {
    readonly journey?: unknown;
    readonly replay?: string;
    readonly binary?: string;
  },
): Promise<Result<ProductCaptureResult>> {
  if ((options.journey === undefined) === (options.replay === undefined))
    return err(vispError("CONFIG_INVALID", "Supply exactly one journey or replay run ID"));
  let capturedFeature: string | undefined;
  let capturedTask: string | undefined;
  const published = await withProductMutation(workspace, async () => {
    const record = await readProductRecord(workspace, options);
    if (!record.ok) return record;
    capturedFeature = record.value.brief.feature;
    const selected =
      options.replay === undefined
        ? ok({ journey: options.journey, task: options.task })
        : replayJourney(record.value.state.captureRuns, options.replay, options.task);
    if (!selected.ok) return selected;
    const slice = selectProductSlice(workspace, record.value, {
      ...options,
      task: selected.value.task,
    });
    if (!slice.ok) return slice;
    // Feature-wide replays remain feature-wide, even when another task is active.
    const task = options.replay === undefined ? slice.value?.id : selected.value.task;
    capturedTask = task;
    const journey = browserJourneySchema.safeParse(selected.value.journey);
    if (!journey.success)
      return err(vispError("CONFIG_INVALID", `Invalid browser journey: ${journey.error.message}`));
    return withProductCapture(
      workspace,
      record.value,
      { journey: journey.data, task, binary: options.binary },
      async (prepared) => {
        const saved = await saveProductState(
          workspace,
          record.value,
          prepared.state,
          prepared.mutations,
        );
        if (!saved.ok) return saved;
        const inspected = await inspectProductImages(
          workspace,
          prepared.subjectDigest,
          prepared.result.captures,
          prepared.result.captures.map((capture) => capture.id),
        );
        return ok({
          ...prepared.result,
          replayCommand: replayCommand(record.value.brief.feature, prepared.result.runId, task),
          images: inspected.images,
          imageGaps: [
            ...inspected.gaps,
            ...inspected.availability
              .filter((image) => image.status === "not-delivered")
              .map((image) => `${image.id}: ${image.reason}`),
          ],
          observationPlan: productObservationPlan(
            { ...record.value, state: prepared.state },
            prepared.subjectDigest,
            record.value.brief.slices.find((entry) => entry.id === task),
          ),
        });
      },
    );
  });
  const recovered = replayCaptureRecovery(published, options, capturedFeature, capturedTask);
  if (!recovered.ok) return recovered;

  // The capture transaction must be fully committed before next/status reads
  // the new run. This also keeps read-only critic routing outside the lock.
  const next = await runProductNext(workspace, {
    feature: capturedFeature,
    task: capturedTask,
  });
  if (!next.ok)
    return ok({
      ...recovered.value,
      nextCommand: recovered.value.nextCommand,
    });
  return ok({
    ...recovered.value,
    next: next.value,
    nextCommand:
      criticRouteCommand(next.value) ?? next.value.command ?? recovered.value.nextCommand,
  });
}

function replayCaptureRecovery(
  published: Result<ProductCaptureResult>,
  options: ProductSelection & { readonly replay?: string; readonly binary?: string },
  capturedFeature?: string,
  capturedTask?: string,
): Result<ProductCaptureResult> {
  if (published.ok || !options.replay || published.error.details?.gap !== "browser-unavailable")
    return published;
  const recovery = supportedHostCaptureRecovery({
    feature: options.feature ?? capturedFeature,
    task: options.task ?? capturedTask,
    replay: options.replay,
    binary: options.binary,
  });
  return err({
    ...published.error,
    recovery: recovery.message,
    details: { ...published.error.details, supportedHostOption: recovery.option },
  });
}
