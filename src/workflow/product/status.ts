import type { VispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { outcomeStatuses, type ProductOutcomeStatus } from "./assessment.js";
import { criticNext } from "./critic-guidance.js";
import { hasUntakenPrompts } from "./host-prompts.js";
import { productInputWarnings } from "./input-warnings.js";
import type { ProductBrief, ProductState } from "./model.js";
import { productReviewDocument } from "./review-document.js";
import { earlierSessionGrant } from "./scopes.js";
import type { ProductIdentity } from "./status-history.js";
import { nextFromRecord } from "./status-next.js";
import {
  briefPath,
  type ProductRecord,
  type ProductSelection,
  readProductRecord,
} from "./store.js";
import {
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "./subject.js";
import { userFeedbackPlan } from "./user-feedback.js";

export type ProductAction =
  | "understand"
  | "implement"
  | "fix"
  | "refine"
  | "accept"
  | "complete"
  | "wait";
export interface ProductNext {
  readonly action: ProductAction;
  readonly objective: string;
  readonly command?: string;
  readonly feature?: string;
  readonly task?: string;
  readonly evidence: readonly string[];
  readonly mayEdit: boolean;
  /** `handoff`: the review budget is spent; the open findings go to a human reviewer. */
  readonly completion?: "unresolved-environment" | "unresolved-product" | "handoff";
  readonly recovery?: string;
  readonly criticAdvice?: {
    status: "suggested" | "unavailable" | "feedback";
    command?: string;
    guidance: string;
    findings?: readonly unknown[];
    comparisons?: readonly unknown[];
    evidenceRequest?: string;
    limitations?: readonly string[];
  };
  readonly userFeedback?: ReturnType<typeof userFeedbackPlan>;
}

export async function hasProductFeature(
  workspace: WorkspaceState,
  feature?: string,
): Promise<boolean> {
  const id = feature ?? workspace.status?.activeFeature;
  if (!id) return false;
  const exists = await workspace.files.exists(briefPath(workspace, id));
  return exists.ok && exists.value;
}

export async function runProductNext(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductNext>> {
  const loaded = await readProductRecord(workspace, options);
  if (!loaded.ok) return unavailableNext(loaded.error, workspace, options);
  const untaken = await newSessionRequestNext(workspace, loaded.value, options);
  if (!untaken.ok || untaken.value) return untaken.ok ? ok(untaken.value as ProductNext) : untaken;
  const next = await nextFromRecord(workspace, loaded.value, options, () =>
    currentProductIdentity(workspace, loaded.value.brief),
  );
  if (!next.ok) return next;
  const warnings = await productInputWarnings(workspace, loaded.value.brief);
  const result = await criticNext(workspace, {
    ...next.value,
    evidence: [...next.value.evidence, ...warnings],
  });
  if (!result.ok || (!loaded.value.state.criticManual && !loaded.value.state.userFeedback?.length))
    return result;
  const subject = await productSourceDigest(workspace, loaded.value.brief);
  if (!subject.ok) return subject;
  const slice = loaded.value.brief.slices.find((entry) => entry.id === next.value.task);
  return ok({
    ...result.value,
    userFeedback: userFeedbackPlan(workspace, loaded.value, slice, subject.value),
  });
}

export interface ProductStatus {
  readonly feature?: string;
  readonly brief?: ProductBrief;
  readonly state?: ProductState;
  readonly subjectDigest?: string;
  readonly outcomes: readonly ProductOutcomeStatus[];
  readonly next: ProductNext;
  readonly report: string;
}

async function currentProductIdentity(
  workspace: WorkspaceState,
  brief: ProductBrief,
): Promise<Result<ProductIdentity>> {
  const snapshot = await productSourceSnapshot(workspace, brief);
  if (!snapshot.ok) return snapshot;
  const subject = await productSourceDigest(workspace, brief, snapshot.value);
  return subject.ok
    ? ok({
        subject: subject.value,
        implementation: productImplementationDigest(workspace, snapshot.value),
      })
    : subject;
}

export async function runProductStatus(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<ProductStatus>> {
  const record = await readProductRecord(workspace, options);
  if (!record.ok) {
    const next = unavailableNext(record.error, workspace, options);
    if (!next.ok) return next;
    return ok({
      feature: next.value.feature,
      outcomes: [],
      next: next.value,
      report: `${next.value.objective}\n\n${next.value.command}\n`,
    });
  }
  // One operation-local snapshot. Subsequent calls still refresh from disk.
  let snapshot: Promise<Result<ProductIdentity>> | undefined;
  const getIdentity = () => (snapshot ??= currentProductIdentity(workspace, record.value.brief));
  const planned = await nextFromRecord(workspace, record.value, options, getIdentity);
  if (!planned.ok) return planned;
  const next = await criticNext(workspace, planned.value);
  if (!next.ok) return next;
  const identity = await getIdentity();
  if (!identity.ok) return identity;
  const subject = ok(identity.value.subject);
  const outcomes = outcomeStatuses(record.value, subject.value);
  const report = await productReviewDocument(workspace, record.value, outcomes, next.value);
  return ok({
    feature: record.value.brief.feature,
    brief: record.value.brief,
    state: record.value.state,
    subjectDigest: subject.value,
    outcomes,
    next: next.value,
    report,
  });
}

export async function runProductReport(
  workspace: WorkspaceState,
  options: ProductSelection = {},
): Promise<Result<{ feature?: string; markdown: string; next: ProductNext }>> {
  const status = await runProductStatus(workspace, options);
  return status.ok
    ? ok({ feature: status.value.feature, markdown: status.value.report, next: status.value.next })
    : status;
}

/**
 * A later session's request goes to a feature of its own. Workers in a new session asked
 * `visp next`, were sent to the earlier session's open task, and built the new request there,
 * without its rules, recalled decisions or a review of its own. A prompt no feature has taken,
 * sent after the open task's authorization lapsed with its session, is that new request.
 */
async function newSessionRequestNext(
  workspace: WorkspaceState,
  record: ProductRecord,
  options: ProductSelection,
): Promise<Result<ProductNext | undefined>> {
  // A worker that names the feature or task has already chosen to continue it.
  if (options.feature || options.task) return ok(undefined);
  const earlier = await earlierSessionGrant(workspace, record);
  if (!earlier.ok || !earlier.value) return earlier.ok ? ok(undefined) : earlier;
  const untaken = await hasUntakenPrompts(workspace);
  if (!untaken.ok || !untaken.value) return untaken.ok ? ok(undefined) : untaken;
  const { task } = earlier.value;
  return ok({
    action: "understand",
    objective: `The user's request in this session is not part of ${record.brief.feature}, which an earlier session left open: start it as its own feature`,
    command: 'visp feature "<the user\'s request>"',
    evidence: [
      `Only if the user asked to continue "${record.brief.goal}": visp work --feature ${record.brief.feature} --task ${task}`,
    ],
    mayEdit: false,
  });
}

function unavailableNext(
  error: VispError,
  workspace: WorkspaceState,
  options: ProductSelection,
): Result<ProductNext> {
  if (error.code === "NO_ACTIVE_FEATURE")
    return ok({
      action: "understand",
      objective: "Record the original request and define the next useful outcome",
      command: 'visp feature "<goal>"',
      evidence: [],
      mayEdit: false,
    });
  if (error.code === "MIGRATION_REQUIRED")
    return ok({
      action: "understand",
      objective: "Preview and migrate this feature to the product workflow",
      command: error.recovery ?? "visp migrate --dry-run",
      feature: options.feature ?? workspace.status?.activeFeature,
      evidence: ["MIGRATION_REQUIRED: legacy artifacts remain historical and unchanged"],
      mayEdit: false,
    });
  return err(error);
}
