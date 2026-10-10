import { inspectFileTransactions } from "../core/file-transaction.js";
import { discoverProjectRoot } from "../core/project-root.js";
import { ok, type Result } from "../core/result.js";
import type { ImplementMarker } from "../workflow/artifacts/evidence.js";
import { resolveRule, ruleContextFor } from "../workflow/policy/resolve.js";
import {
  hasPendingCriticReview,
  PENDING_REVIEW_MESSAGE,
} from "../workflow/product/critic-policy.js";
import { activeBlockedPaths, earlierSessionAuthorization } from "../workflow/product/scopes.js";
import { isStatePath, type WorkspaceState } from "../workflow/state.js";
import { checkPaths, type ScopeViolation } from "./guard.js";

export type GuardViolation =
  | ScopeViolation
  | {
      readonly path: string;
      readonly reason: "transaction-pending" | "review-pending";
      readonly message: string;
    };

export async function pendingTransactionViolations(
  root: string,
): Promise<Result<GuardViolation[]>> {
  const checked = await inspectFileTransactions(discoverProjectRoot(root));
  if (!checked.ok) return checked;
  return ok(
    checked.value.pending.length
      ? [
          {
            path: ".visp/state/transactions",
            reason: "transaction-pending",
            message: "An interrupted VISP update is pending, so scope cannot be checked safely",
          },
        ]
      : [],
  );
}

/** The shared CLI/MCP write decision after authorization markers are selected. */
export async function evaluateGuardPaths(
  state: WorkspaceState,
  paths: readonly string[],
  markers: readonly ImplementMarker[],
  options: {
    feature?: string;
    task?: string;
    hostSession?: string;
    source?: "markers" | "tasks";
    writeTime?: boolean;
  } = {},
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
  let violations: GuardViolation[] = checkPaths(paths, {
    markers,
    blockedPaths: blockedPaths.value,
    enforceAllowedFiles: allowedRule.active,
    writeTime: options.writeTime,
  });
  if (
    options.source !== "tasks" &&
    violations.some((entry) => entry.reason === "no-authorization")
  ) {
    const earlier = await earlierSessionAuthorization(state, {
      ...(options.feature ? { feature: options.feature } : {}),
      ...(options.hostSession ? { hostSession: options.hostSession } : {}),
    });
    if (!earlier.ok) return earlier;
    if (earlier.value) {
      const auth = earlier.value;
      violations = violations.map((entry) =>
        entry.reason === "no-authorization"
          ? {
              ...entry,
              message: `${entry.path} was authorized for ${auth.task} of ${auth.feature} in an earlier session, which no longer permits edits. For a new request, start it with \`visp feature "<request>"\`; to continue ${auth.task}, run \`visp work --task ${auth.task}\``,
            }
          : entry,
      );
    }
  }
  const feature = options.feature ?? state.status?.activeFeature ?? markers[0]?.feature;
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
