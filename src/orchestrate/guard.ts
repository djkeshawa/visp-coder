import { STATE_DIR } from "../core/constants.js";
import { firstMatch, matchesAny } from "../core/patterns.js";
import type { ImplementMarker } from "../workflow/artifacts/evidence.js";

/**
 * The one place that decides whether a path may be written. The CLI guard, the
 * PreToolUse hook, the pre-commit hook, and CI all call this, so a refusal has
 * the same meaning and the same wording everywhere.
 */

export type ScopeDecision =
  | { readonly allowed: true; readonly reason: "in-scope" | "state-directory" }
  | {
      readonly allowed: false;
      readonly reason:
        | "invalid-path"
        | "blocked-path"
        | "forbidden-file"
        | "outside-allowed-files"
        | "no-authorization";
      readonly message: string;
      readonly pattern?: string;
    };

export interface ScopeInput {
  /** Repository-relative POSIX path. */
  readonly path: string;
  /**
   * False when a recorded override waives `scope.allowed-files`. Blocked paths
   * and a task's forbidden list are never affected: those rules cannot be
   * overridden, so the escape hatch cannot reach them.
   */
  readonly enforceAllowedFiles?: boolean;
  /** Active per-task authorizations. Any one of them may permit the write. */
  readonly markers: readonly ImplementMarker[];
  /** Paths blocked project-wide, from visp.yml. */
  readonly blockedPaths: readonly string[];
}

export function decideScope(input: ScopeInput): ScopeDecision {
  const normalized = normalizeScopePath(input.path);
  if (!normalized.ok) {
    return {
      allowed: false,
      reason: "invalid-path",
      message:
        "The path must be a non-empty project-relative path without parent traversal or an absolute prefix",
    };
  }
  const path = normalized.path;

  // Workflow state is the tool's own bookkeeping, not the change under review.
  if (path === STATE_DIR || path.startsWith(`${STATE_DIR}/`)) {
    return { allowed: true, reason: "state-directory" };
  }

  const blocked = firstMatch(path, input.blockedPaths);
  if (blocked !== undefined) {
    return {
      allowed: false,
      reason: "blocked-path",
      pattern: blocked,
      message: `${path} is blocked project-wide by "${blocked}"`,
    };
  }

  if (input.markers.length === 0) {
    return {
      allowed: false,
      reason: "no-authorization",
      message: `No task is authorized to write ${path}`,
    };
  }

  // Forbidden wins over allowed, across every active marker.
  for (const marker of input.markers) {
    const forbidden = firstMatch(path, marker.forbiddenFiles);
    if (forbidden !== undefined) {
      return {
        allowed: false,
        reason: "forbidden-file",
        pattern: forbidden,
        message: `${path} is forbidden for ${marker.task} by "${forbidden}"`,
      };
    }
  }

  const permitting = input.markers.find((marker) => matchesAny(path, marker.allowedFiles));
  if (permitting) return { allowed: true, reason: "in-scope" };

  if (input.enforceAllowedFiles === false) return { allowed: true, reason: "in-scope" };

  const tasks = input.markers.map((marker) => marker.task).join(", ");
  return {
    allowed: false,
    reason: "outside-allowed-files",
    message: `${path} is outside the allowed files of ${tasks}`,
  };
}

export interface ScopeViolation {
  readonly path: string;
  readonly reason: Exclude<ScopeDecision, { allowed: true }>["reason"];
  readonly message: string;
}

/** Checks a set of changed files, returning every violation rather than the first. */
export function checkPaths(
  paths: readonly string[],
  context: Omit<ScopeInput, "path">,
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const path of paths) {
    const decision = decideScope({ ...context, path });
    if (!decision.allowed) {
      violations.push({ path, reason: decision.reason, message: decision.message });
    }
  }
  return violations;
}

/** Files a task was expected to touch but did not. */
export function missingExpectedFiles(
  changed: readonly string[],
  marker: ImplementMarker,
): string[] {
  const normalized = changed.map(normalizeForMatching);
  return marker.expectedFiles.filter(
    (pattern) => !normalized.some((path) => matchesAny(path, [pattern])),
  );
}

type NormalizedScopePath = { readonly ok: true; readonly path: string } | { readonly ok: false };

/**
 * Normalize only benign relative-path syntax. Parent traversal and absolute
 * prefixes are rejected before any policy exemption or glob is evaluated.
 */
function normalizeScopePath(input: string): NormalizedScopePath {
  if (input.length === 0 || input.includes("\0")) return { ok: false };

  const slashes = input.replace(/\\/g, "/");
  if (slashes.startsWith("/") || /^[A-Za-z]:/.test(slashes)) return { ok: false };

  const segments: string[] = [];
  for (const segment of slashes.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false };
    segments.push(segment);
  }

  const path = segments.join("/");
  if (path.length === 0 || /^[A-Za-z]:/.test(path)) return { ok: false };
  return { ok: true, path };
}

function normalizeForMatching(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
