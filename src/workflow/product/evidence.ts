import { vispError } from "../../core/errors.js";
import { type FileMutation, filePrecondition } from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import { CHECK_OUTPUT_GUIDANCE } from "../product-output-guidance.js";
import type { WorkspaceState } from "../state.js";
import { pinnedAcceptanceChecks } from "./acceptance-checks.js";
import {
  applicableExecutions,
  finalProductAssessmentGaps,
  outcomeStatuses,
  type ProductOutcomeStatus,
  productEvidenceGaps,
} from "./assessment.js";
import { checkBehaviorChanges } from "./behavior-changes.js";
import { executeProductCheck } from "./check-execution.js";
import { ensureProductCheckpoint } from "./checkpoint.js";
import { productNeighborhood } from "./context.js";
import { correctionChecks } from "./corrections.js";
import { requireNoPendingCriticReview } from "./critic-policy.js";
import { environmentNext } from "./environment.js";
import { currentJourneyFeedback } from "./evidence-references.js";
import { productFailureSignature } from "./failures.js";
import { findingAppliesToSlice, outstandingFeedback, productFeedbackPlan } from "./feedback.js";
import {
  checksFor,
  closedSlice,
  PRODUCT_REVIEW_POLICY,
  type ProductCheck,
  type ProductExecution,
  type ProductSlice,
  type ProductState,
} from "./model.js";
import { withProductMutation } from "./runtime.js";
import { checkProductScope, selectProductSlice } from "./scopes.js";
import { type ProductNext, runProductNext } from "./status.js";
import {
  authorizationPath,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
  saveProductState,
  statusMutation,
} from "./store.js";
import { productContractDigest, productSourceDigest, productSourceSnapshot } from "./subject.js";

export type { ProductOutcomeStatus } from "./assessment.js";
export { type ProductReviewBundle, type ProductReviewOptions, runProductReview } from "./review.js";

export interface ProductVerification {
  readonly checkpoint?: { candidate: string; provenance: string } | { gap: string };
  readonly delivery?: { status: string; summary: string };
  readonly nextCommand?: string;
  readonly next?: ProductNext;
  readonly recovery?: string;
  readonly feature: string;
  readonly task?: string;
  readonly subjectDigest: string;
  readonly passed: boolean;
  readonly closed?: boolean;
  readonly executions: readonly ProductExecution[];
  readonly behaviorChanges?: ReturnType<typeof checkBehaviorChanges>;
  readonly outcomes: readonly ProductOutcomeStatus[];
  readonly gaps: readonly string[];
  readonly journeyFeedback?: ReturnType<typeof currentJourneyFeedback>;
  readonly recommendation?: string;
  readonly feedbackPlan?: ReturnType<typeof productFeedbackPlan>;
  readonly trace?: { graph: import("../../graph/index.js").QueryRow[]; notes: string[] };
}

export const runProductVerify = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> =>
  withProductMutation(workspace, () => execute(workspace, options, false, false));
export const runProductDone = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> =>
  withProductMutation(workspace, () => execute(workspace, options, true, false));
export const runProductAccept = (
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductVerification>> =>
  withProductMutation(workspace, () => execute(workspace, options, false, true));

async function execute(
  workspace: WorkspaceState,
  options: ProductSelection,
  close: boolean,
  accept: boolean,
): Promise<Result<ProductVerification>> {
  const prepared = await prepareExecution(workspace, options, close, accept);
  if (!prepared.ok) return prepared;
  const { record, slice, source, snapshot, commands } = prepared.value;
  const checked = await executeChecks(
    workspace,
    record,
    slice,
    source,
    commands,
    close,
    options.retryEnvironment,
    snapshot,
  );
  const { executions } = checked;
  const afterSnapshot = await productSourceSnapshot(workspace, record.brief);
  if (!afterSnapshot.ok) return afterSnapshot;
  const after = await productSourceDigest(workspace, record.brief, afterSnapshot.value);
  if (!after.ok) return after;
  const timestamp = new Date().toISOString();
  const next = {
    ...checked.state,
    updatedAt: timestamp,
    executions: [...record.state.executions, ...executions],
  };
  const current: ProductRecord = { ...record, state: next };
  const gaps = await executionGaps(workspace, current, slice, after.value, commands, executions);
  if (source !== after.value) gaps.push(changedProductGap(snapshot, afterSnapshot.value));
  if (close)
    gaps.push(
      ...outstandingFeedback(current)
        .filter((entry) => entry.required && findingAppliesToSlice(entry, slice))
        .map((entry) => `${entry.id}: ${entry.problem}. ${entry.nextCheck}`),
    );
  if (accept) gaps.push(...finalProductAssessmentGaps(current, after.value));
  const passed = gaps.length === 0;
  const completion = await completionState(workspace, record, next, {
    slice,
    close,
    accept,
    passed,
    subject: after.value,
  });
  if (!completion.ok) return completion;
  const saved = await saveProductState(workspace, record, completion.value.state, [
    ...checked.mutations,
    ...completion.value.mutations,
  ]);
  if (!saved.ok) return saved;
  const checkpoint = await ensureProductCheckpoint(workspace, {
    feature: record.brief.feature,
    task: slice?.id,
  });
  const trace = close
    ? await productNeighborhood(workspace, Object.keys(afterSnapshot.value), true)
    : undefined;
  const failed = executions.filter((execution) => execution.status === "failed");
  const repeated = failed.some((execution) =>
    record.state.executions.some(
      (before) =>
        before.check === execution.check &&
        before.status === "failed" &&
        productFailureSignature(before) === productFailureSignature(execution),
    ),
  );
  const progress = await verificationProgress(workspace, current, slice, after.value);
  return ok({
    ...deliveryResult(
      record.brief.feature,
      slice?.id,
      passed,
      close,
      accept,
      executions.some((entry) => entry.status === "environment-failed"),
    ),
    checkpoint: checkpointDelivery(checkpoint),
    ...progress,
    ...(trace?.ok ? { trace: trace.value } : {}),
    feature: record.brief.feature,
    ...(slice ? { task: slice.id } : {}),
    subjectDigest: after.value,
    passed,
    ...(close ? { closed: passed } : {}),
    executions,
    outcomes: outcomeStatuses(current, after.value, slice),
    gaps: [...new Set(gaps)],
    journeyFeedback: currentJourneyFeedback(current, after.value, slice?.id),
    behaviorChanges: checkBehaviorChanges(record.state.executions, executions),
    ...(repeated
      ? {
          recommendation:
            "The same product failure recurred. Test a different hypothesis or request a focused review; metadata edits do not constitute progress.",
        }
      : {}),
  });
}

/** One scheduler serves verify/done, status and next, including critic-owned assessments. */
async function verificationProgress(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
) {
  const next = await runProductNext(workspace, { feature: record.brief.feature, task: slice?.id });
  const feedbackPlan = productFeedbackPlan(
    record,
    subject,
    slice,
    workspace.config.workflow.reviewMode,
  );
  return {
    feedbackPlan,
    ...(next.ok ? { next: next.value, nextCommand: next.value.command } : {}),
  };
}

function deliveryResult(
  feature: string,
  task: string | undefined,
  passed: boolean,
  close: boolean,
  accept: boolean,
  environmentFailed: boolean,
) {
  const recovery = environmentNext(feature, task, [], "verify");
  const delivery = environmentFailed
    ? {
        status: "unresolved-environment",
        summary:
          "Not complete: required execution or review could not run. Recover the environment; product quality remains unverified.",
      }
    : !passed
      ? {
          status: "unresolved-product",
          summary: "Not complete: required product checks or assessments remain unresolved.",
        }
      : accept
        ? {
            status: "accepted",
            summary: "Required product acceptance checks and assessments passed.",
          }
        : close
          ? {
              status: "slice-closed",
              summary: "This slice is closed. Run visp next before reporting the feature complete.",
            }
          : {
              status: "checks-passed",
              summary:
                "Checks passed. Product completion still requires closure and final acceptance.",
            };
  return {
    delivery,
    nextCommand: environmentFailed ? recovery.command : "visp next",
    ...(environmentFailed ? { recovery: recovery.recovery } : {}),
  };
}

interface PreparedExecution {
  record: ProductRecord;
  slice?: ProductSlice;
  source: string;
  snapshot: Record<string, string>;
  commands: ProductCheck[];
}
async function prepareExecution(
  workspace: WorkspaceState,
  options: ProductSelection,
  close: boolean,
  accept: boolean,
): Promise<Result<PreparedExecution>> {
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return loaded;
  const record = loaded.value;
  const editable = await closeoutAvailability(workspace, record.brief.feature, close, accept);
  if (!editable.ok) return editable;
  // Final acceptance is deliberately feature-wide, regardless of active local task.
  const selection = selectProductSlice(workspace, record, options, close);
  if (!selection.ok) return selection;
  const slice = accept ? undefined : selection.value;
  if (close && !slice) return err(vispError("NO_ACTIVE_TASK", "No slice selected for closure"));
  if (
    accept &&
    record.brief.slices.some((entry) => !closedSlice(record.state.slices[entry.id]?.status))
  )
    return err(
      vispError("STAGE_BLOCKED", "Close the active slices before final product acceptance"),
    );
  if (slice && !closedSlice(record.state.slices[slice.id]?.status)) {
    const scope = await checkProductScope(workspace, record, slice);
    if (!scope.ok)
      return err({
        ...scope.error,
        message: `${scope.error.message}; no checks or browser retry were run`,
        details: {
          ...scope.error.details,
          executionAttempted: false,
          browserRetryAttempted: false,
        },
      });
  }
  const snapshot = await productSourceSnapshot(workspace, record.brief);
  if (!snapshot.ok) return snapshot;
  const source = await productSourceDigest(workspace, record.brief, snapshot.value);
  if (!source.ok) return source;
  const commands = executionCommands(workspace, record, slice, accept, source.value);
  return ok({ record, slice, source: source.value, snapshot: snapshot.value, commands });
}

function closeoutAvailability(
  workspace: WorkspaceState,
  feature: string,
  close: boolean,
  accept: boolean,
): Promise<Result<void>> {
  return close || accept
    ? requireNoPendingCriticReview(
        workspace,
        feature,
        "Submit the pending reviewer result or wait for its deadline before closing or accepting",
      )
    : Promise.resolve(ok(undefined));
}

function lastOpenSlice(record: ProductRecord, slice: ProductSlice): boolean {
  return record.brief.slices.every(
    (entry) => entry.id === slice.id || closedSlice(record.state.slices[entry.id]?.status),
  );
}

function executionCommands(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  accept: boolean,
  subject: string,
): ProductCheck[] {
  const { brief } = record;
  const commands = [
    ...new Map(
      [...checksFor(brief, slice), ...(slice ? correctionChecks(record, slice, subject) : [])].map(
        (check) => [check.id, check],
      ),
    ).values(),
  ];
  // The last open slice completes the product, so the pinned tests should pass there too.
  if (accept || !slice || lastOpenSlice(record, slice))
    commands.push(...pinnedAcceptanceChecks(brief));
  for (const [index, command] of workspace.config.workflow.validationCommands.entries())
    commands.push({
      id: `CONFIG_${index + 1}`,
      command,
      outcomes: [],
      files: [],
      environment: "other",
    });
  return commands;
}

async function executeChecks(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  source: string,
  commands: ProductCheck[],
  close: boolean,
  retryEnvironment = false,
  verifierSnapshot: Record<string, string> = {},
): Promise<{ executions: ProductExecution[]; state: ProductState; mutations: FileMutation[] }> {
  const executions: ProductExecution[] = [];
  const mutations: FileMutation[] = [];
  let state = record.state;
  const existing = new Map(
    applicableExecutions(record, source).map((execution) => [
      executionOwnerKey(execution.check, execution.task),
      execution,
    ]),
  );
  for (const check of commands) {
    // A check added by an assembled failure keeps its feature-wide contract identity.
    // Binding it to a slice that does not declare it would hide later check revisions.
    const owner = slice?.checks.includes(check.id) ? slice : undefined;
    // `done` reuses only this owner's result. Explicit verify and acceptance rerun checks.
    if (close && existing.get(executionOwnerKey(check.id, owner?.id))?.status === "passed")
      continue;
    const checked = await executeProductCheck(
      workspace,
      { ...record, state },
      owner,
      check,
      source,
      retryEnvironment,
      verifierSnapshot,
    );
    executions.push(checked.execution);
    state = checked.state;
    mutations.push(...checked.mutations);
  }
  return { executions, state, mutations };
}

async function executionGaps(
  workspace: WorkspaceState,
  current: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
  commands: ProductCheck[],
  executions: ProductExecution[],
): Promise<string[]> {
  const gaps = await productEvidenceGaps(workspace, current, subject, slice);
  for (const execution of executions)
    if (execution.status !== "passed")
      gaps.push(`${execution.check}: ${execution.status}: ${execution.output}`);
  const requiredCommands = new Map(
    applicableExecutions(current, subject).map((execution) => [
      executionOwnerKey(execution.check, execution.task),
      execution,
    ]),
  );
  for (const check of commands)
    if (
      requiredCommands.get(
        executionOwnerKey(check.id, slice?.checks.includes(check.id) ? slice.id : undefined),
      )?.status !== "passed"
    )
      gaps.push(`${check.id}: no current passing execution`);
  return gaps;
}

function executionOwnerKey(check: string, task?: string) {
  return JSON.stringify([check, task]);
}

function changedProductGap(before: Record<string, string>, after: Record<string, string>): string {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
  const prefix =
    "Product changed while checks ran; these executions describe the previous version.";
  if (!changed.length) return `${prefix} Control, runtime or environment inputs changed.`;
  const paths = changed.slice(0, 12).map((path) => JSON.stringify(path.slice(0, 200)));
  const omitted = changed.length > paths.length ? ` (+${changed.length - paths.length} more)` : "";
  return `${prefix} Changed input paths: ${paths.join(", ")}${omitted}. ${CHECK_OUTPUT_GUIDANCE}`;
}

async function completionState(
  workspace: WorkspaceState,
  record: ProductRecord,
  next: ProductState,
  options: {
    slice?: ProductSlice;
    close: boolean;
    accept: boolean;
    passed: boolean;
    subject: string;
  },
): Promise<Result<{ state: ProductState; mutations: FileMutation[] }>> {
  const { slice, close, accept, passed, subject } = options;
  const failedAcceptanceStatus = next.status === "accepted" ? "active" : next.status;
  const extra: FileMutation[] = [];
  if (passed && close && slice) {
    next.sliceHistory = [
      ...next.sliceHistory,
      {
        task: slice.id,
        from: record.state.slices[slice.id]?.status ?? "pending",
        to: "closed",
        createdAt: next.updatedAt,
        subjectDigest: subject,
        reason: "Required slice checks and review passed",
      },
    ];
    next.slices = {
      ...next.slices,
      [slice.id]: {
        status: "closed" as const,
        contractDigest: productContractDigest(record.brief, slice),
      },
    };
    const auth = await workspace.files.readTextIfExists(
      authorizationPath(workspace, record.brief.feature),
    );
    if (!auth.ok) return auth;
    if (auth.value && JSON.parse(auth.value).task === slice.id)
      extra.push({
        kind: "remove" as const,
        path: authorizationPath(workspace, record.brief.feature),
        expectedBefore: filePrecondition(auth.value),
      });
    const status = await statusMutation(workspace, record.brief.feature, undefined, "done");
    if (!status.ok) return status;
    extra.push(status.value);
  }
  if (accept) {
    Object.assign(
      next,
      passed
        ? {
            status: "accepted",
            acceptedSubject: subject,
            acceptedContract: productContractDigest(record.brief),
            acceptedReviewPolicy: PRODUCT_REVIEW_POLICY,
          }
        : {
            status: failedAcceptanceStatus,
            acceptedSubject: undefined,
            acceptedContract: undefined,
            acceptedReviewPolicy: undefined,
          },
    );
  }
  return ok({ state: next, mutations: extra });
}

function checkpointDelivery(result: Awaited<ReturnType<typeof ensureProductCheckpoint>>) {
  if (!result.ok) return { gap: result.error.message };
  if (!result.value) return undefined;
  return {
    candidate: result.value.candidate,
    provenance:
      "First observed implementation; not a passing quality assessment. Preserve it when correcting behavior or visuals.",
  };
}
