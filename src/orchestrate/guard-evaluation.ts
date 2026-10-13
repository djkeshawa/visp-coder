import { GUARD_PROTOCOL_VERSION, STATE_DIR } from "../core/constants.js";
import { changesSince, stagedChanges, trackedFiles, workingTreeChanges } from "../core/git.js";
import { ok, type Result } from "../core/result.js";
import { inspectSettledTransactions } from "../core/transaction-inspection.js";
import { type RuntimeIdentity, runtimeIdentity } from "../core/version.js";
import { requireInstalledRuntime } from "../harness/runtime.js";
import type { ImplementMarker } from "../workflow/artifacts/evidence.js";
import { resolveRule, ruleContextFor } from "../workflow/policy/resolve.js";
import { branchFeatures, branchScopes } from "../workflow/product/branch-scope.js";
import {
  hasPendingCriticReview,
  PENDING_REVIEW_MESSAGE,
} from "../workflow/product/critic-policy.js";
import { unchangedInheritedPaths } from "../workflow/product/inherited-changes.js";
import {
  activeBlockedPaths,
  activeProtectedEnvChanges,
  productScopes as authorizedScopes,
  earlierSessionAuthorization,
} from "../workflow/product/scopes.js";
import { isStatePath, type WorkspaceState } from "../workflow/state.js";
import { checkPaths, type ScopeViolation } from "./guard.js";

/**
 * The guard decision, shared by `visp guard` (what the hooks and CI call) and the MCP
 * `visp_guard` tool, so a refusal means the same thing on every surface. The adapters only
 * load the workspace and render the answer.
 */

export type GuardViolation =
  | ScopeViolation
  | {
      readonly path: string;
      readonly reason: "transaction-pending" | "review-pending";
      readonly message: string;
    };

export interface GuardPayload {
  readonly runtime: RuntimeIdentity;
  readonly protocolVersion: typeof GUARD_PROTOCOL_VERSION;
  readonly checked: number;
  readonly allowed: boolean;
  readonly violations: GuardViolation[];
  readonly authorizedTasks: string[];
  /** On a scope refusal: the refused paths that a closed task of this feature declared. */
  readonly committable?: string[];
  /** On a pending-transaction refusal: the journals still pending. */
  readonly transactions?: readonly string[];
}

/** What is being asked. `paths` is a write-time question; the rest select a diff and scope. */
export interface GuardRequest {
  readonly paths?: readonly string[];
  readonly staged?: boolean;
  readonly all?: boolean;
  readonly base?: string;
  readonly task?: string;
  readonly scope?: "markers" | "tasks";
  readonly feature?: string;
  /** The host session asking; another session's authorization permits no edits. */
  readonly session?: string;
  readonly branch?: string;
  readonly ifAuthorized?: boolean;
  readonly includeDone?: boolean;
}

export type GuardEvaluation =
  | { readonly kind: "unscoped"; readonly payload: GuardPayload }
  | {
      readonly kind: "checked";
      readonly paths: string[];
      readonly markers: ImplementMarker[];
      readonly committable: string[];
      readonly payload: GuardPayload;
    };

export interface PendingTransactionRefusal {
  /** A live VISP process is saving, so the call can simply be retried. */
  readonly saving: boolean;
  readonly payload: GuardPayload;
}

/** The first step of every guard: an interrupted VISP update makes scope unreadable. */
export async function pendingTransactionRefusal(
  root: string,
): Promise<Result<PendingTransactionRefusal | undefined>> {
  const transactions = await inspectSettledTransactions(root);
  if (!transactions.ok) return transactions;
  if (transactions.value.pending.length === 0) return ok(undefined);
  const { saving } = transactions.value;
  const violation: GuardViolation = {
    path: `${STATE_DIR}/state/transactions`,
    reason: "transaction-pending",
    message: saving
      ? "VISP is saving an update; retry this edit shortly"
      : "An interrupted VISP update is pending, so scope cannot be checked safely",
  };
  return ok({
    saving,
    payload: { ...payload(0, [violation], []), transactions: transactions.value.pending },
  });
}

/** Every step after the workspace is loaded: markers, paths, scope, review and session. */
export async function evaluateGuardRequest(
  state: WorkspaceState,
  request: GuardRequest,
): Promise<Result<GuardEvaluation>> {
  const feature = await resolveGuardFeature(state, request);
  if (!feature.ok) return feature;
  const selected = await selectGuardMarkers(state, request, feature.value);
  if (!selected.ok) return selected;
  if (selected.value.kind === "unscoped")
    return evaluateUnscopedGuard(state, request, feature.value);
  // Committed task scope is a CI comparison, not local permission to edit.
  if (request.scope !== "tasks" && selected.value.markers.length > 0) {
    const agreed = await requireInstalledRuntime(state.paths, state.files);
    if (!agreed.ok) return agreed;
  }

  const checked = await checkedPaths(state, request, feature.value);
  if (!checked.ok) return checked;
  const paths = checked.value;
  const markers = selected.value.markers;
  const guarded = await evaluateGuardPaths(state, paths, markers, {
    ...(feature.value ? { feature: feature.value } : {}),
    ...(request.task ? { task: request.task } : {}),
    ...(request.session ? { hostSession: request.session } : {}),
    ...(request.scope ? { source: request.scope } : {}),
    writeTime: request.paths !== undefined,
  });
  if (!guarded.ok) return guarded;
  const violations = guarded.value;
  const committable = request.includeDone ? [] : await closedTaskPaths(state, violations);
  const tasks = markers.map((marker) => marker.task);
  return ok({
    kind: "checked",
    paths,
    markers,
    committable,
    payload: {
      ...payload(paths.length, violations, tasks),
      ...(violations.length > 0 ? { committable } : {}),
    },
  });
}

/** The asked or changed paths, plus ignored secret-file changes a diff omits. */
async function checkedPaths(
  state: WorkspaceState,
  request: GuardRequest,
  feature: string | undefined,
): Promise<Result<string[]>> {
  const paths = await resolveScopedPaths(state, request, feature);
  if (!paths.ok) return paths;
  if (request.paths || request.scope === "tasks") return paths;
  const protectedChanges = await activeProtectedEnvChanges(state);
  if (!protectedChanges.ok) return protectedChanges;
  return ok([...new Set([...paths.value, ...protectedChanges.value])]);
}

function payload(
  checked: number,
  violations: GuardViolation[],
  authorizedTasks: string[],
): GuardPayload {
  return {
    runtime: runtimeIdentity(),
    protocolVersion: GUARD_PROTOCOL_VERSION,
    checked,
    allowed: violations.length === 0,
    violations,
    authorizedTasks,
  };
}

async function resolveGuardFeature(
  state: WorkspaceState,
  request: GuardRequest,
): Promise<Result<string | undefined>> {
  if (request.scope !== "tasks") return ok(request.feature);
  const features = await branchFeatures(state, request);
  return features.ok ? ok(features.value[0]) : features;
}

async function evaluateUnscopedGuard(
  state: WorkspaceState,
  request: GuardRequest,
  feature: string | undefined,
): Promise<Result<GuardEvaluation>> {
  const unscoped = ok({ kind: "unscoped" as const, payload: payload(0, [], []) });
  const reviewFeature = feature ?? state.status?.activeFeature;
  if (!reviewFeature) return unscoped;
  const pending = await hasPendingCriticReview(state, reviewFeature);
  if (!pending.ok) return pending;
  if (!pending.value) return unscoped;
  const paths = await resolvePaths(state.paths.root, request);
  if (!paths.ok) return paths;
  const violations: GuardViolation[] = paths.value
    .filter((path) => !isStatePath(path))
    .map((path) => ({
      path,
      reason: "review-pending" as const,
      message: PENDING_REVIEW_MESSAGE,
    }));
  if (violations.length === 0) return unscoped;
  return ok({
    kind: "checked",
    paths: paths.value,
    markers: [],
    committable: [],
    payload: { ...payload(paths.value.length, violations, []), committable: [] },
  });
}

type GuardMarkerSelection =
  | { readonly kind: "unscoped" }
  | { readonly kind: "markers"; readonly markers: ImplementMarker[] };

/** The feature and asking session every scope lookup of one guard call shares. */
function scopeFilter(request: GuardRequest, feature: string | undefined) {
  return {
    ...(feature ? { feature } : {}),
    ...(request.session ? { hostSession: request.session } : {}),
  };
}

async function selectGuardMarkers(
  state: WorkspaceState,
  request: GuardRequest,
  feature: string | undefined,
): Promise<Result<GuardMarkerSelection>> {
  if (request.scope === "tasks") {
    const markers = await branchScopes(state, request);
    return markers.ok ? ok({ kind: "markers", markers: markers.value }) : markers;
  }
  if (request.ifAuthorized) {
    const active = await authorizedScopes(state, scopeFilter(request, feature));
    if (!active.ok) return active;
    if (active.value.length === 0) return ok({ kind: "unscoped" });
  }
  const markers = await authorizedScopes(state, {
    includeDone: request.includeDone === true,
    ...(request.scope ? { source: request.scope } : {}),
    ...scopeFilter(request, feature),
  });
  if (!markers.ok) return markers;
  if (request.ifAuthorized && markers.value.length === 0) return ok({ kind: "unscoped" });
  return ok({ kind: "markers", markers: markers.value });
}

/** The scope decision for given paths, after authorization markers are selected. */
async function evaluateGuardPaths(
  state: WorkspaceState,
  paths: readonly string[],
  markers: readonly ImplementMarker[],
  options: {
    feature?: string;
    task?: string;
    hostSession?: string;
    source?: "markers" | "tasks";
    writeTime?: boolean;
  },
): Promise<Result<GuardViolation[]>> {
  const allowedRule = resolveRule(
    "scope.allowed-files",
    state.policy,
    state.overrides,
    ruleContextFor(state, {
      stage: "implement",
      ...(options.feature ? { feature: options.feature } : {}),
      ...(options.task ? { task: options.task } : {}),
    }),
  );
  const blockedPaths =
    options.source === "tasks"
      ? ok(state.config.workflow.blockedPaths)
      : await activeBlockedPaths(state);
  if (!blockedPaths.ok) return blockedPaths;
  const violations = checkPaths(paths, {
    markers,
    blockedPaths: blockedPaths.value,
    enforceAllowedFiles: allowedRule.active,
    writeTime: options.writeTime,
  });
  const explained = await explainEarlierSession(state, violations, options);
  if (!explained.ok) return explained;
  return withPendingReview(state, paths, markers, explained.value, options.feature);
}

/** A refusal under an earlier session's grant names both ways on, not just "unauthorized". */
async function explainEarlierSession(
  state: WorkspaceState,
  violations: GuardViolation[],
  options: { feature?: string; hostSession?: string; source?: "markers" | "tasks" },
): Promise<Result<GuardViolation[]>> {
  if (
    options.source === "tasks" ||
    !violations.some((entry) => entry.reason === "no-authorization")
  )
    return ok(violations);
  const earlier = await earlierSessionAuthorization(state, {
    ...(options.feature ? { feature: options.feature } : {}),
    ...(options.hostSession ? { hostSession: options.hostSession } : {}),
  });
  if (!earlier.ok) return earlier;
  const auth = earlier.value;
  if (!auth) return ok(violations);
  return ok(
    violations.map((entry) =>
      entry.reason === "no-authorization"
        ? {
            ...entry,
            message: `${entry.path} was authorized for ${auth.task} of ${auth.feature} in an earlier session, which no longer permits edits. For a new request, start it with \`visp feature "<request>"\`; to continue ${auth.task}, run \`visp work --task ${auth.task}\``,
          }
        : entry,
    ),
  );
}

/** While an independent review is pending, every path not already refused waits for it. */
async function withPendingReview(
  state: WorkspaceState,
  paths: readonly string[],
  markers: readonly ImplementMarker[],
  violations: GuardViolation[],
  requested: string | undefined,
): Promise<Result<GuardViolation[]>> {
  const feature = requested ?? state.status?.activeFeature ?? markers[0]?.feature;
  if (!feature || paths.length === 0) return ok(violations);
  const pending = await hasPendingCriticReview(state, feature);
  if (!pending.ok) return pending;
  if (!pending.value) return ok(violations);
  const refused = new Set(violations.map((entry) => entry.path));
  return ok([
    ...violations,
    ...paths
      .filter((path) => !refused.has(path) && !isStatePath(path))
      .map((path) => ({
        path,
        reason: "review-pending" as const,
        message: PENDING_REVIEW_MESSAGE,
      })),
  ]);
}

/** Paths a closed task in this feature declared, so the refusal can say so. */
async function closedTaskPaths(
  state: WorkspaceState,
  violations: readonly { path: string }[],
): Promise<string[]> {
  if (violations.length === 0) return [];

  const withDone = await authorizedScopes(state, { includeDone: true });
  if (!withDone.ok) return [];

  const stillRefused = new Set(
    checkPaths(
      violations.map((violation) => violation.path),
      { markers: withDone.value, blockedPaths: state.config.workflow.blockedPaths },
    ).map((violation) => violation.path),
  );

  return violations.map((violation) => violation.path).filter((path) => !stillRefused.has(path));
}

/**
 * The working-tree diff leaves out uncommitted work the feature inherited because Git
 * cannot be written, while it is unchanged: it is earlier work, not this feature's change.
 * A staged diff is not filtered: the index may hold content that differs from the file.
 */
async function resolveScopedPaths(
  state: WorkspaceState,
  request: GuardRequest,
  feature: string | undefined,
): Promise<Result<string[]>> {
  const paths = await resolvePaths(state.paths.root, request);
  const localDiff =
    !request.paths?.length &&
    !request.all &&
    !request.base &&
    !request.staged &&
    request.scope !== "tasks";
  if (!paths.ok || !localDiff) return paths;
  const inherited = await unchangedInheritedPaths(state, feature ?? state.status?.activeFeature);
  return inherited.size ? ok(paths.value.filter((path) => !inherited.has(path))) : paths;
}

async function resolvePaths(root: string, request: GuardRequest): Promise<Result<string[]>> {
  if (request.paths && request.paths.length > 0) return ok([...request.paths]);

  // A different question from the others: not "is this change in scope" but
  // "what in this repository is outside every task's scope". On a real project
  // the answer is most of it, which is correct and not very actionable — it is
  // for auditing what a feature has authorized, not for a pre-commit check.
  if (request.all) {
    const tracked = await trackedFiles(root);
    if (!tracked.ok) return tracked;
    return ok(tracked.value.filter((path) => !isStatePath(path)));
  }

  const diff = request.base
    ? await changesSince(root, request.base)
    : request.staged
      ? await stagedChanges(root)
      : await workingTreeChanges(root);

  if (!diff.ok) return diff;

  // visp's own artifacts change on every command and are never a violation.
  // An explicit path is answered as asked; a diff is not padded with them.
  return ok(diff.value.files.map((file) => file.path).filter((path) => !isStatePath(path)));
}
