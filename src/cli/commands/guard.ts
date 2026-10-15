import { Command } from "commander";
import { BLOCK, GUARD_PROTOCOL_VERSION } from "../../core/constants.js";
import { type VispError, vispError } from "../../core/errors.js";
import { ok } from "../../core/result.js";
import { runtimeIdentity } from "../../core/version.js";
import {
  evaluateGuardRequest,
  type GuardEvaluation,
  type GuardPayload,
  type GuardRequest,
  pendingTransactionRefusal,
} from "../../orchestrate/guard-evaluation.js";
import { PENDING_REVIEW_MESSAGE } from "../../workflow/product/critic/critic-policy.js";
import { productScopes as authorizedScopes } from "../../workflow/product/scopes.js";
import type { WorkspaceState } from "../../workflow/state.js";
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
      "--session <id>",
      "The host session asking; another session's authorization permits no edits",
    )
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
  readonly session?: string;
  readonly feature?: string;
  readonly branch?: string;
}

async function handleGuardCommand(_flags: unknown, command: Command): Promise<void> {
  const opts = options<GuardCliOptions>(command);
  process.exitCode = await executeGuardCommand(opts);
}

async function executeGuardCommand(opts: GuardCliOptions): Promise<number> {
  const sourceError = guardScopeSourceError(opts.scope);
  if (sourceError) return emitError("guard", sourceError, { json: isJson(opts) });
  const identifiers = validateArtifactSelection(opts);
  if (!identifiers.ok) return emitError("guard", identifiers.error, { json: isJson(opts) });
  const transactions = await pendingTransactionRefusal(projectRoot(opts));
  if (!transactions.ok) return emitError("guard", transactions.error, { json: isJson(opts) });
  if (transactions.value) {
    const { saving, payload } = transactions.value;
    const message = payload.violations[0]?.message ?? "";
    return emitRefusal("guard", payload, saving ? message : `${message}. Run: visp doctor --fix`, {
      json: isJson(opts),
    });
  }
  const state = await workspace(opts);
  if (!state.ok) return emitError("guard", state.error, { json: isJson(opts) });
  if (opts.handshake) return emitGuardHandshake(opts, state.value);
  const evaluated = await evaluateGuardRequest(state.value, guardRequest(opts));
  if (!evaluated.ok) return emitError("guard", evaluated.error, { json: isJson(opts) });
  return emitGuardEvaluation(opts, evaluated.value);
}

/** The CLI flags as the shared guard request. */
function guardRequest(opts: GuardCliOptions): GuardRequest {
  return {
    ...(opts.path ? { paths: opts.path } : {}),
    ...(opts.staged ? { staged: true } : {}),
    ...(opts.all ? { all: true } : {}),
    ...(opts.base ? { base: opts.base } : {}),
    ...(opts.task ? { task: opts.task } : {}),
    ...(opts.scope ? { scope: opts.scope as "markers" | "tasks" } : {}),
    ...(opts.feature ? { feature: opts.feature } : {}),
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.ifAuthorized ? { ifAuthorized: true } : {}),
    ...(opts.includeDone ? { includeDone: true } : {}),
  };
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

function emitGuardEvaluation(opts: GuardCliOptions, evaluation: GuardEvaluation): number {
  if (evaluation.kind === "unscoped") {
    return emit("guard", ok(evaluation.payload), {
      json: isJson(opts),
      text: () => "No task is authorized, so there is no scope to check.",
    });
  }
  if (evaluation.payload.allowed) {
    return emit("guard", ok(evaluation.payload), {
      json: isJson(opts),
      text: () => guardAllowedText(evaluation.paths.length),
    });
  }
  return emitRefusal("guard", evaluation.payload, guardRefusalText(opts, evaluation), {
    json: isJson(opts),
  });
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
      opts.scope === "tasks"
        ? "CI checks the union of declared feature scopes. Commit the matching briefs or correct the PR scope before retrying."
        : guardClosing(evaluation),
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

/** Enough to see the shape of a refusal without scrolling past it. */
const SHOWN_VIOLATIONS = 20;
