import { vispError } from "../../core/errors.js";
import { err, ok } from "../../core/result.js";
import { productCaptureRunSchema } from "../product/evidence-references.js";
import { isExploratoryJourney, journeyRetirementSchema } from "../product/journey-ownership.js";
import { withProductMutation } from "../product/runtime.js";
import { selectProductSlice } from "../product/scopes.js";
import { runProductNext } from "../product/status.js";
import {
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
} from "../product/store.js";
import type { WorkspaceState } from "../state.js";
import { relatedReplayRuns, replayJourney } from "./capture-replay.js";
import { type ProductCaptureResult, runProductCapture } from "./product-capture.js";

export interface ProductCaptureOptions extends ProductSelection {
  readonly journey?: unknown;
  readonly replay?: string;
  readonly replayBatch?: string;
  readonly retire?: string;
  readonly reason?: string;
  readonly outcomes?: readonly string[];
  readonly binary?: string;
}

/** Adapter entry point: every mode keeps raw capture receipts unchanged. */
export async function runProductCaptureAction(
  workspace: WorkspaceState,
  options: ProductCaptureOptions,
) {
  const modes = [options.journey, options.replay, options.replayBatch, options.retire];
  if (
    modes.filter((mode) => mode !== undefined).length !== 1 ||
    (options.reason !== undefined && !options.retire)
  )
    return err(
      vispError(
        "CONFIG_INVALID",
        "Supply exactly one journey, replay, replay-batch or retire; reason is only for retirement",
      ),
    );
  if (options.retire && options.outcomes !== undefined)
    return err(
      vispError("CONFIG_INVALID", "Outcome links apply to capture execution, not retirement"),
    );
  if (options.retire) return retireJourney(workspace, options);
  if (options.replayBatch) return replayBatch(workspace, options);
  return runProductCapture(workspace, options);
}

async function retireJourney(workspace: WorkspaceState, options: ProductCaptureOptions) {
  const retired = await withProductMutation(workspace, async () => {
    if (options.signal?.aborted)
      return err(vispError("COMMAND_FAILED", "Capture retirement cancelled"));
    const record = await readProductRecord(workspace, options);
    if (!record.ok) return record;
    const selected = replayJourney(
      record.value.state.captureRuns,
      options.retire ?? "",
      options.task,
    );
    if (!selected.ok) return selected;
    const slice = selectProductSlice(workspace, record.value, {
      ...options,
      task: selected.value.task,
    });
    if (!slice.ok) return slice;
    const run = exploratoryRetirementRun(record.value, options.retire);
    if (!run.ok) return run;
    return commitRetirement(workspace, record.value, run.value, options.reason);
  });
  if (!retired.ok) return retired;
  const next = await runProductNext(workspace, {
    feature: retired.value.feature,
    task: retired.value.retirement.task,
  });
  return ok({ ...retired.value, ...(next.ok ? { next: next.value } : {}) });
}

async function replayBatch(workspace: WorkspaceState, options: ProductCaptureOptions) {
  const loaded = await withProductMutation(workspace, () => readProductRecord(workspace, options));
  if (!loaded.ok) return loaded;
  const selected = replayJourney(
    loaded.value.state.captureRuns,
    options.replayBatch ?? "",
    options.task,
  );
  if (!selected.ok) return selected;
  const runs = relatedReplayRuns(loaded.value, options.replayBatch ?? "", selected.value.task);
  if (!runs.length)
    return err(
      vispError("EVIDENCE_FAILED", "No intact replay batch exists for this contract and scope"),
    );
  const results: { sourceRunId: string; result?: ProductCaptureResult; error?: unknown }[] = [];
  for (const run of runs) {
    if (options.signal?.aborted) break;
    await options.onProgress?.({ check: run.id, status: "running" });
    const result = await runProductCapture(workspace, {
      ...options,
      journey: undefined,
      replay: run.id,
      task: selected.value.task,
    });
    results.push(
      result.ok
        ? { sourceRunId: run.id, result: result.value }
        : { sourceRunId: run.id, error: result.error },
    );
  }
  return ok({
    feature: loaded.value.brief.feature,
    task: selected.value.task,
    canonicalRunId: options.replayBatch,
    status: options.signal?.aborted
      ? "cancelled"
      : results.some((entry) => entry.error || entry.result?.status !== "completed")
        ? "failed"
        : "completed",
    runs: results,
    nextCommand: "visp next",
    information:
      "Replayed the canonical input and saved neighbouring transitions unchanged. Each receipt retains its own result; batch completion is not acceptance.",
  });
}

function exploratoryRetirementRun(record: ProductRecord, id?: string) {
  const matches = record.state.captureRuns.flatMap((candidate) => {
    const parsed = productCaptureRunSchema.safeParse(candidate);
    return parsed.success && parsed.data.id === id ? [parsed.data] : [];
  });
  const run = matches[0];
  return run &&
    (run.status === "completed" || run.failure?.kind === "behavior") &&
    isExploratoryJourney(record, run)
    ? ok(run)
    : err(
        vispError(
          "EVIDENCE_FAILED",
          "Only the worker's unlinked exploratory journeys can be retired; declared and reviewer-required obligations remain open",
        ),
      );
}

async function commitRetirement(
  workspace: WorkspaceState,
  record: ProductRecord,
  run: ReturnType<typeof productCaptureRunSchema.parse>,
  reason?: string,
) {
  const retirement = journeyRetirementSchema.safeParse({
    runId: run.id,
    journeyDigest: run.journeyDigest,
    task: run.task,
    reason,
    createdAt: new Date().toISOString(),
    provenance: "worker-reported",
  });
  if (!retirement.success)
    return err(
      vispError("CONFIG_INVALID", "Retirement requires a one-line reason of 1–500 characters"),
    );
  const previous = record.state.journeyRetirements ?? [];
  if (previous.some((entry) => entry.runId === run.id))
    return err(
      vispError(
        "CONFIG_INVALID",
        "This exploratory journey is already retired; its recorded reason is preserved",
      ),
    );
  const saved = await saveProductState(workspace, record, {
    ...record.state,
    updatedAt: retirement.data.createdAt,
    journeyRetirements: [...previous, retirement.data],
  });
  return saved.ok
    ? ok({
        feature: record.brief.feature,
        retirement: retirement.data,
        originalStatus: run.status,
        information:
          "Exploratory hypothesis retired, not passed. The independent reviewer receives the reason and can still retain a product defect.",
      })
    : saved;
}
