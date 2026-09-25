import { parseFeatureId } from "../../core/input.js";
import { ok, type Result } from "../../core/result.js";
import { activeRules } from "../../workflow/policy/resolve.js";
import { readProductBrief, runProductStatus } from "../../workflow/product/index.js";
import { productScopes as authorizedScopes } from "../../workflow/product/scopes.js";
import { compactProductStatus } from "../../workflow/product-presentation.js";
import { workspaceFor } from "../context.js";

/**
 * Read-only projections of `.visp/`. Resources never compute or mutate; a tool
 * does that, and a resource shows what is on disk.
 */

export async function statusPayload(root: string): Promise<Result<unknown>> {
  const state = await workspaceFor(root);
  if (!state.ok) return state;

  const result = await runProductStatus(state.value, {});
  return result.ok ? ok(compactProductStatus(result.value)) : result;
}

export async function policyPayload(root: string): Promise<Result<unknown>> {
  const state = await workspaceFor(root);
  if (!state.ok) return state;

  const { policy, overrides } = state.value;
  return ok({
    strictness: policy.strictness,
    activeRules: activeRules(policy, overrides).map((rule) => ({
      id: rule.id,
      title: rule.title,
      reason: rule.reason,
      stage: rule.stage,
      overridable: rule.overridable,
    })),
    overrides: overrides.map((override) => ({
      rule: override.rule,
      scope: override.scope,
      expiresAt: override.expiresAt,
      revokedAt: override.revokedAt ?? null,
    })),
    blockedPaths: state.value.config.workflow.blockedPaths,
  });
}

/** What may be written right now, and by which task. */
export async function scopePayload(root: string): Promise<Result<unknown>> {
  const state = await workspaceFor(root);
  if (!state.ok) return state;

  const markers = await authorizedScopes(state.value);
  if (!markers.ok) return markers;

  return ok({
    blockedPaths: state.value.config.workflow.blockedPaths,
    authorized: markers.value.map((marker) => ({
      task: marker.task,
      feature: marker.feature,
      allowedFiles: marker.allowedFiles,
      forbiddenFiles: marker.forbiddenFiles,
      expectedFiles: marker.expectedFiles,
      expiresAt: marker.expiresAt ?? null,
    })),
  });
}

/**
 * An id taken from a resource uri is client-supplied text that becomes a path
 * segment, so it is checked against the shape visp itself allocates before any
 * file is touched. Without this, a value such as `..\..\elsewhere` walks out of
 * `.visp/` on a platform where a backslash separates paths.
 */
export async function briefPayload(root: string, feature: string): Promise<Result<unknown>> {
  const checked = parseFeatureId(feature);
  if (!checked.ok) return checked;

  const state = await workspaceFor(root);
  if (!state.ok) return state;

  return readProductBrief(state.value, { feature });
}
