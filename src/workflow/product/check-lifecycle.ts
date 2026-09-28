import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { applicableExecutions } from "./assessment.js";
import { type ExecutedProductCheck, executeProductCheck } from "./check-execution.js";
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
    if (reuse && existing.get(executionOwnerKey(check.id, owner?.id))?.status === "passed")
      continue;
    await options.onProgress?.({ check: check.id, status: "running" });
    if (options.signal?.aborted) return cancelledExecution();
    const checked = await executeProductCheck(
      workspace,
      current,
      owner,
      check,
      source,
      options.retryEnvironment,
      verifierSnapshot,
      options.signal,
      close,
    );
    if (options.signal?.aborted) return cancelledExecution();
    const saved = await publishCheck(workspace, record, current, checked, batch, options.signal);
    if (!saved.ok) return saved;
    current = saved.value;
    executions.push(checked.execution);
    await options.onProgress?.({ check: check.id, status: checked.execution.status });
  }
  return options.signal?.aborted ? cancelledExecution() : ok(executions);
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

export function executionOwnerKey(check: string, task?: string) {
  return JSON.stringify([check, task]);
}
