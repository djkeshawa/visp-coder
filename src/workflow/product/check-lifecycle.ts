import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { applicableExecutions } from "./assessment.js";
import {
  checkComparisonEnvironment,
  type ExecutedProductCheck,
  executeProductCheck,
} from "./check-execution.js";
import type { ProductCheck, ProductExecution, ProductSlice, ProductState } from "./model.js";
import { withProductMutation } from "./runtime.js";
import {
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
} from "./store.js";

export function cancelledExecution() {
  return err(
    vispError(
      "COMMAND_FAILED",
      "VISP execution cancelled; completed checks were saved. No further closeout was performed",
      {
        recovery: "Retry the same command to continue from completed checks",
        details: { cancelled: true },
      },
    ),
  );
}

export function mergeCaptureState(
  current: ProductState,
  before: ProductState,
  after: ProductState,
): ProductState {
  return {
    ...current,
    captures: [...current.captures, ...after.captures.slice(before.captures.length)],
    captureRuns: [...current.captureRuns, ...after.captureRuns.slice(before.captureRuns.length)],
    ...(after.browserCapability !== before.browserCapability
      ? { browserCapability: after.browserCapability }
      : {}),
  };
}

export function requireExecutionContract(
  before: ProductRecord,
  current: ProductRecord,
): Result<void> {
  return before.state.briefDigest === current.state.briefDigest
    ? ok(undefined)
    : err(
        vispError(
          "STATE_BUSY",
          "The brief changed while checks ran; retry against the updated contract",
          { recovery: "visp next" },
        ),
      );
}

export async function executeChecks(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  source: string,
  commands: ProductCheck[],
  close: boolean,
  accept: boolean,
  options: ProductSelection,
  verifierSnapshot: Record<string, string>,
): Promise<Result<ProductExecution[]>> {
  const executions: ProductExecution[] = [];
  const batch = hashValue({
    source,
    contract: record.state.briefDigest,
    checks: commands,
    task: slice?.id,
    close,
    accept,
  });
  const reuse = close || options.reusePassed || record.state.pendingVerification === batch;
  const existing = new Map(
    applicableExecutions(record, source).map((entry) => [
      executionOwnerKey(entry.check, entry.task),
      entry,
    ]),
  );
  let current = record;
  for (const check of commands) {
    if (options.signal?.aborted) return cancelledExecution();
    const owner = slice?.checks.includes(check.id) ? slice : undefined;
    if (reuse && (await reusable(workspace, record, check, existing.get(key(check, owner)))))
      continue;
    const ran = await runCheck(workspace, record, current, {
      check,
      owner,
      source,
      batch,
      close,
      options,
      verifierSnapshot,
    });
    if (!ran.ok) return ran;
    current = ran.value.record;
    executions.push(ran.value.execution);
  }
  return options.signal?.aborted ? cancelledExecution() : ok(executions);
}

interface CheckRun {
  readonly check: ProductCheck;
  readonly owner: ProductSlice | undefined;
  readonly source: string;
  readonly batch: string;
  readonly close: boolean;
  readonly options: ProductSelection;
  readonly verifierSnapshot: Record<string, string>;
}

/** Execute one check and publish its receipt; a cancellation at any step stops the batch. */
async function runCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  current: ProductRecord,
  run: CheckRun,
): Promise<Result<{ record: ProductRecord; execution: ProductExecution }>> {
  const { check, options } = run;
  await options.onProgress?.({ check: check.id, status: "running" });
  if (options.signal?.aborted) return cancelledExecution();
  const checked = await executeProductCheck(
    workspace,
    current,
    run.owner,
    check,
    run.source,
    options.retryEnvironment,
    run.verifierSnapshot,
    options.signal,
    run.close,
  );
  if (options.signal?.aborted) return cancelledExecution();
  const saved = await publishCheck(workspace, record, current, checked, run.batch, options.signal);
  if (!saved.ok) return saved;
  await options.onProgress?.({ check: check.id, status: checked.execution.status });
  return ok({ record: saved.value, execution: checked.execution });
}

/**
 * The subject no longer carries the toolchain, so a pass earned under another PATH, node,
 * injected NODE_OPTIONS, locale or browser must run again. This gates every reuse trigger:
 * closing, accept's second pass, and a pending verification of the same batch.
 */
async function reusable(
  workspace: WorkspaceState,
  record: ProductRecord,
  check: ProductCheck,
  prior: ProductExecution | undefined,
) {
  if (prior?.status !== "passed" || !prior.comparisonEnvironment?.trim()) return false;
  const current = await checkComparisonEnvironment(workspace, record.brief, check);
  return current.ok && current.value === prior.comparisonEnvironment;
}

function publishCheck(
  workspace: WorkspaceState,
  record: ProductRecord,
  current: ProductRecord,
  checked: ExecutedProductCheck,
  batch: string,
  signal?: AbortSignal,
) {
  return withProductMutation(workspace, async () => {
    if (signal?.aborted) return cancelledExecution();
    const loaded = await readProductRecord(workspace, { feature: record.brief.feature });
    if (!loaded.ok) return loaded;
    const contract = requireExecutionContract(record, loaded.value);
    if (!contract.ok) return contract;
    const state = {
      ...mergeCaptureState(loaded.value.state, current.state, checked.state),
      updatedAt: new Date().toISOString(),
      pendingVerification: batch,
      executions: [...loaded.value.state.executions, checked.execution],
    };
    const published = await saveProductState(workspace, loaded.value, state, checked.mutations);
    return published.ok
      ? readProductRecord(workspace, { feature: record.brief.feature })
      : published;
  });
}

function key(check: ProductCheck, owner?: ProductSlice) {
  return executionOwnerKey(check.id, owner?.id);
}

export function executionOwnerKey(check: string, task?: string) {
  return JSON.stringify([check, task]);
}
