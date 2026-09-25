import { Command } from "commander";
import { BLOCK, GUARD_PROTOCOL_VERSION, STATE_DIR } from "../../core/constants.js";
import { type VispError, vispError } from "../../core/errors.js";
import { inspectFileTransactions } from "../../core/file-transaction.js";
import { changesSince, stagedChanges, trackedFiles, workingTreeChanges } from "../../core/git.js";
import { ok, type Result } from "../../core/result.js";
import { type RuntimeIdentity, runtimeIdentity } from "../../core/version.js";
import { requireInstalledRuntime } from "../../harness/runtime.js";
import { checkPaths, decideScope, type ScopeViolation } from "../../orchestrate/guard.js";
import type { ImplementMarker } from "../../workflow/artifacts/evidence.js";
import { resolveRule, ruleContextFor } from "../../workflow/policy/resolve.js";
import {
  hasPendingCriticReview,
  PENDING_REVIEW_MESSAGE,
} from "../../workflow/product/critic-policy.js";
import { productScopes as authorizedScopes } from "../../workflow/product/scopes.js";
import { featureForBranch, isStatePath, type WorkspaceState } from "../../workflow/state.js";
import {
  type GlobalOptions,
  isJson,
  options,
  projectRoot,
  validateArtifactSelection,
  workspace,
} from "../context.js";
import { block, bullet, emit, emitError, emitRefusal } from "../output.js";

/**
 * The mechanical scope check. Hooks and CI call this, so a refusal here is the
 * same refusal a human sees.
 */
export function guardCommand(): Command {
  return new Command("guard")
    .description("Check changed files against the active task's allowed scope")
    .option("--path <path...>", "Check these paths instead of reading a diff")
    .option("--staged", "Check staged changes")
    .option("--all", "Check every tracked file, not just what changed")
    .option("--base <ref>", "Check changes since this reference")
    .option("--task <id>", "Resolve overrides against this task instead of the active one")
    .option("--handshake", "Verify the guard protocol without making a scope decision")
    .option("--if-authorized", "Pass when no task is authorized, instead of refusing every path")
    .option(
      "--include-done",
      "Also allow files from tasks already closed in this feature, for committing finished work",
    )
    .option(
      "--scope <source>",
      "Where scope comes from: markers (this worktree) or tasks (the committed graph)",
    )
    .option("--feature <id>", "Which feature's graph to judge against, with --scope tasks")
    .option(
      "--branch <name>",
      "Which branch this checkout represents, when git cannot say (a CI checkout is detached)",
    )
    .action(handleGuardCommand);
}

interface GuardCliOptions extends GlobalOptions {
  readonly path?: string[];
  readonly staged?: boolean;
  readonly all?: boolean;
  readonly base?: string;
  readonly handshake?: boolean;
  readonly ifAuthorized?: boolean;
  readonly includeDone?: boolean;
  readonly task?: string;
  readonly scope?: string;
  readonly feature?: string;
  readonly branch?: string;
}

interface GuardPayload {
  readonly runtime: RuntimeIdentity;
  readonly protocolVersion: typeof GUARD_PROTOCOL_VERSION;
  readonly checked: number;
  readonly allowed: boolean;
  readonly violations: GuardViolation[];
  readonly authorizedTasks: string[];
}

type GuardViolation =
  | ScopeViolation
  | {
      readonly path: string;
      readonly reason: "transaction-pending" | "review-pending";
      readonly message: string;
    };

type GuardEvaluation =
  | { readonly kind: "unscoped" }
  | {
      readonly kind: "checked";
      readonly paths: string[];
      readonly markers: ImplementMarker[];
      readonly committable: string[];
      readonly payload: GuardPayload;
    };

async function handleGuardCommand(_flags: unknown, command: Command): Promise<void> {
  const opts = options<GuardCliOptions>(command);
  process.exitCode = await executeGuardCommand(opts);
}

async function executeGuardCommand(opts: GuardCliOptions): Promise<number> {
  const sourceError = guardScopeSourceError(opts.scope);
  if (sourceError) return emitError("guard", sourceError, { json: isJson(opts) });
  const identifiers = validateArtifactSelection(opts);
  if (!identifiers.ok) return emitError("guard", identifiers.error, { json: isJson(opts) });
  const transactions = await inspectFileTransactions(projectRoot(opts));
  if (!transactions.ok) return emitError("guard", transactions.error, { json: isJson(opts) });
  if (transactions.value.pending.length > 0) {
    const message = "An interrupted VISP update is pending, so scope cannot be checked safely";
    return emitRefusal(
      "guard",
      {
        runtime: runtimeIdentity(),
        protocolVersion: GUARD_PROTOCOL_VERSION,
        checked: 0,
        allowed: false,
        violations: [
          {
            path: `${STATE_DIR}/state/transactions`,
            reason: "transaction-pending",
            message,
          },
        ],
        authorizedTasks: [],
        transactions: transactions.value.pending,
      },
      `${message}. Run: visp doctor --fix`,
      { json: isJson(opts) },
    );
  }
  const state = await workspace(opts);
  if (!state.ok) return emitError("guard", state.error, { json: isJson(opts) });
  if (opts.handshake) return emitGuardHandshake(opts, state.value);
  const feature = await resolveGuardFeature(state.value, opts);
  if (!feature.ok) return emitError("guard", feature.error, { json: isJson(opts) });
  const evaluated = await evaluateGuard(state.value, opts, feature.value);
  if (!evaluated.ok) return emitError("guard", evaluated.error, { json: isJson(opts) });
  return emitGuardEvaluation(opts, evaluated.value);
}

async function emitGuardHandshake(opts: GuardCliOptions, state: WorkspaceState): Promise<number> {
  const markers = await authorizedScopes(state, {
    ...(opts.feature ? { feature: opts.feature } : {}),
  });
  // A protocol handshake enables installation of the migration-capable harness.
  // It checks no paths and grants no legacy authorization; ordinary guards still refuse it.
  if (!markers.ok && markers.error.code !== "MIGRATION_REQUIRED")
    return emitError("guard", markers.error, { json: isJson(opts) });
  return emit(
    "guard",
    ok({
      runtime: runtimeIdentity(),
      protocolVersion: GUARD_PROTOCOL_VERSION,
      checked: 0,
      allowed: true,
      violations: [],
      authorizedTasks: markers.ok ? markers.value.map((marker) => marker.task) : [],
    } satisfies GuardPayload),
    {
      json: isJson(opts),
      text: () => "The installed guard protocol is available.",
    },
  );
}

function guardScopeSourceError(scope: string | undefined): VispError | undefined {
  if (scope === undefined || scope === "markers" || scope === "tasks") return undefined;
  return vispError("UNSUPPORTED", `Unknown scope source: ${scope}`, {
    recovery: "Use --scope markers or --scope tasks",
  });
}

async function resolveGuardFeature(
  state: WorkspaceState,
  opts: GuardCliOptions,
): Promise<Result<string | undefined>> {
  const feature =
    opts.scope === "tasks"
      ? (opts.feature ?? (await featureForBranch(state, opts.branch)))
      : opts.feature;
  if (opts.scope !== "tasks" || feature) return ok(feature);
  return {
    ok: false,
    error: vispError(
      "NO_ACTIVE_FEATURE",
      "No feature matches this branch, so there is no graph to judge against",
      {
        recovery:
          "visp guard --scope tasks --feature <id>, or --branch <name> if this checkout is detached",
      },
    ),
  };
}

async function evaluateGuard(
  state: WorkspaceState,
  opts: GuardCliOptions,
  feature: string | undefined,
): Promise<Result<GuardEvaluation>> {
  const selected = await selectGuardMarkers(state, opts, feature);
  if (!selected.ok) return selected;
  if (selected.value.kind === "unscoped") return evaluateUnscopedGuard(state, opts, feature);
  // Committed task scope is a CI comparison, not local permission to edit.
  if (opts.scope !== "tasks" && selected.value.markers.length > 0) {
    const agreed = await requireInstalledRuntime(state.paths, state.files);
    if (!agreed.ok) return agreed;
  }

  const paths = await resolvePaths(state.paths.root, opts);
  if (!paths.ok) return paths;
  const markers = selected.value.markers;
  const allowedFilesRule = resolveRule(
    "scope.allowed-files",
    state.policy,
    state.overrides,
    ruleContextFor(state, { ...(opts.task ? { task: opts.task } : {}) }),
  );
  const violations: GuardViolation[] = checkPaths(paths.value, {
    markers,
    blockedPaths: state.config.workflow.blockedPaths,
    enforceAllowedFiles: allowedFilesRule.active,
  });
  const guarded = await pendingReviewViolations(
    state,
    feature ?? state.status?.activeFeature ?? markers[0]?.feature,
    paths.value,
    violations,
  );
  if (!guarded.ok) return guarded;
  const checkedViolations = guarded.value;
  const committable = opts.includeDone ? [] : await closedTaskPaths(state, checkedViolations);
  return ok({
    kind: "checked",
    paths: paths.value,
    markers,
    committable,
    payload: {
      runtime: runtimeIdentity(),
      protocolVersion: GUARD_PROTOCOL_VERSION,
      checked: paths.value.length,
      allowed: checkedViolations.length === 0,
      violations: checkedViolations,
      authorizedTasks: markers.map((marker) => marker.task),
    },
  });
}

async function evaluateUnscopedGuard(
  state: WorkspaceState,
  opts: GuardCliOptions,
  feature: string | undefined,
): Promise<Result<GuardEvaluation>> {
  const reviewFeature = feature ?? state.status?.activeFeature;
  if (!reviewFeature) return ok({ kind: "unscoped" });
  const pending = await hasPendingCriticReview(state, reviewFeature);
  if (!pending.ok) return pending;
  if (!pending.value) return ok({ kind: "unscoped" });
  const paths = await resolvePaths(state.paths.root, opts);
  if (!paths.ok) return paths;
  const violations: GuardViolation[] = paths.value
    .filter((path) => !isStatePath(path))
    .map((path) => ({
      path,
      reason: "review-pending" as const,
      message: PENDING_REVIEW_MESSAGE,
    }));
  if (violations.length === 0) return ok({ kind: "unscoped" });
  return ok({
    kind: "checked",
    paths: paths.value,
    markers: [],
    committable: [],
    payload: {
      runtime: runtimeIdentity(),
      protocolVersion: GUARD_PROTOCOL_VERSION,
      checked: paths.value.length,
      allowed: false,
      violations,
      authorizedTasks: [],
    },
  });
}

async function pendingReviewViolations(
  state: WorkspaceState,
  feature: string | undefined,
  paths: readonly string[],
  violations: readonly GuardViolation[],
): Promise<Result<GuardViolation[]>> {
  if (!feature || paths.length === 0) return ok([...violations]);
  const pending = await hasPendingCriticReview(state, feature);
  if (!pending.ok) return pending;
  if (!pending.value) return ok([...violations]);
  const alreadyRefused = new Set(violations.map((violation) => violation.path));
  return ok([
    ...violations,
    ...paths
      .filter((path) => !alreadyRefused.has(path) && !isStatePath(path))
      .map((path) => ({
        path,
        reason: "review-pending" as const,
        message: PENDING_REVIEW_MESSAGE,
      })),
  ]);
}

type GuardMarkerSelection =
  | { readonly kind: "unscoped" }
  | { readonly kind: "markers"; readonly markers: ImplementMarker[] };

async function selectGuardMarkers(
  state: WorkspaceState,
  opts: GuardCliOptions,
  feature: string | undefined,
): Promise<Result<GuardMarkerSelection>> {
  if (opts.ifAuthorized && opts.scope !== "tasks") {
    const active = await authorizedScopes(state, {
      ...(feature ? { feature } : {}),
    });
    if (!active.ok) return active;
    if (active.value.length === 0) return ok({ kind: "unscoped" });
  }
  const markers = await authorizedScopes(state, {
    includeDone: opts.includeDone === true,
    ...(opts.scope ? { source: opts.scope as "markers" | "tasks" } : {}),
    ...(feature ? { feature } : {}),
  });
  if (!markers.ok) return markers;
  if (opts.ifAuthorized && markers.value.length === 0) return ok({ kind: "unscoped" });
  return ok({ kind: "markers", markers: markers.value });
}

function emitGuardEvaluation(opts: GuardCliOptions, evaluation: GuardEvaluation): number {
  if (evaluation.kind === "unscoped") {
    return emit(
      "guard",
      ok({
        runtime: runtimeIdentity(),
        protocolVersion: GUARD_PROTOCOL_VERSION,
        checked: 0,
        allowed: true,
        violations: [],
        authorizedTasks: [],
      }),
      {
        json: isJson(opts),
        text: () => "No task is authorized, so there is no scope to check.",
      },
    );
  }
  if (evaluation.payload.allowed) {
    return emit("guard", ok(evaluation.payload), {
      json: isJson(opts),
      text: () => guardAllowedText(evaluation.paths.length),
    });
  }
  return emitRefusal(
    "guard",
    { ...evaluation.payload, committable: evaluation.committable },
    guardRefusalText(opts, evaluation),
    { json: isJson(opts) },
  );
}

function guardAllowedText(count: number): string {
  return count === 0
    ? "No changes to check."
    : `All ${count} changed ${count === 1 ? "file is" : "files are"} in scope.`;
}

function guardRefusalText(
  opts: GuardCliOptions,
  evaluation: Extract<GuardEvaluation, { kind: "checked" }>,
): string {
  const violations = evaluation.payload.violations;
  return block(
    BLOCK.guard,
    [
      `Refused: ${violations.length} of ${evaluation.paths.length} ${opts.all ? "tracked" : "changed"} files are out of scope.`,
      bullet(violations.slice(0, SHOWN_VIOLATIONS).map((violation) => violation.message)),
      violations.length > SHOWN_VIOLATIONS
        ? `  ... and ${violations.length - SHOWN_VIOLATIONS} more (--json for all of them)`
        : "",
      "",
      guardClosing(evaluation),
    ].join("\n"),
  );
}

function guardClosing(evaluation: Extract<GuardEvaluation, { kind: "checked" }>): string {
  if (evaluation.payload.violations.some((violation) => violation.reason === "review-pending"))
    return `${PENDING_REVIEW_MESSAGE}.`;
  if (evaluation.committable.length > 0) {
    return `${evaluation.committable.length} of these belong to a task that is already closed. They are committable as they stand; the editor hook refuses further edits to them until a new task is authorized.`;
  }
  return evaluation.markers.length === 0
    ? "No task is authorized. Run: visp work --task <id>"
    : `Authorized tasks: ${evaluation.markers.map((marker) => marker.task).join(", ")}`;
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

async function resolvePaths(
  root: string,
  opts: { path?: string[]; staged?: boolean; base?: string; all?: boolean },
) {
  if (opts.path && opts.path.length > 0) {
    return { ok: true as const, value: opts.path };
  }

  // A different question from the others: not "is this change in scope" but
  // "what in this repository is outside every task's scope". On a real project
  // the answer is most of it, which is correct and not very actionable — it is
  // for auditing what a feature has authorized, not for a pre-commit check.
  if (opts.all) {
    const tracked = await trackedFiles(root);
    if (!tracked.ok) return tracked;
    return { ok: true as const, value: tracked.value.filter((path) => !isStatePath(path)) };
  }

  const diff = opts.base
    ? await changesSince(root, opts.base)
    : opts.staged
      ? await stagedChanges(root)
      : await workingTreeChanges(root);

  if (!diff.ok) return diff;

  // visp's own artifacts change on every command and are never a violation.
  // An explicit --path is answered as asked; a diff is not padded with them.
  return {
    ok: true as const,
    value: diff.value.files.map((file) => file.path).filter((path) => !isStatePath(path)),
  };
}

export { decideScope };

/** Enough to see the shape of a refusal without scrolling past it. */
const SHOWN_VIOLATIONS = 20;
