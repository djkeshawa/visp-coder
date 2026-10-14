import { vispError } from "../core/errors.js";
import { parseFeatureId } from "../core/input.js";
import { err, ok, type Result } from "../core/result.js";
import type { WorkspaceState } from "./state.js";

/** The feature a command should act on: an explicit choice, or the active one. */
export function resolveFeature(state: WorkspaceState, explicit?: string): Result<string> {
  if (explicit !== undefined) return parseFeatureId(explicit);
  const feature = explicit ?? state.status?.activeFeature;
  if (!feature) {
    return err(
      vispError("NO_ACTIVE_FEATURE", state.checkoutNotice ?? "No feature is active", {
        recovery: state.checkoutNotice ? "git switch -" : 'visp feature "<goal>"',
      }),
    );
  }
  return ok(feature);
}
