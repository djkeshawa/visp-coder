import { CRITIC_CALL_TIMEOUT_MS, CRITIC_MAX_CALLS } from "../../config/critic.js";
import type { WorkspaceState } from "../state.js";
import { featureCriticBudgetGap, readFeatureCriticBudget } from "./critic-budget.js";
import { relaunchBlocked } from "./critic-status.js";
import { criticSelection, readCriticState } from "./critic-store.js";
import { reviewerRules } from "./pinned-dispute-model.js";

/** Whether VISP's own reviewer can still run on this source; `reason` is a sentence for the worker. */
export interface ReviewerCapacity {
  readonly available: boolean;
  readonly reason?: string;
}

const AVAILABLE: ReviewerCapacity = { available: true };

/**
 * The one predicate for "VISP's reviewer cannot run again": the feature's call budget or time
 * budget is spent, or the reviewer already failed twice on this source. Positive evidence only:
 * anything unreadable, unconfigured or not launched by VISP counts as available, so a handoff
 * happens only when the recorded budget or attempts prove it.
 */
export async function reviewerCapacity(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
  task?: string,
): Promise<ReviewerCapacity> {
  if (!reviewerRules(workspace)) return AVAILABLE;
  try {
    return await recordedCapacity(workspace, feature, subject, task);
  } catch {
    return AVAILABLE;
  }
}

async function recordedCapacity(
  workspace: WorkspaceState,
  feature: string,
  subject: string,
  task?: string,
): Promise<ReviewerCapacity> {
  const selected = await criticSelection(workspace, { feature, task });
  if (!selected.ok) return AVAILABLE;
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return AVAILABLE;
  const state = stored.value.state;
  const timeoutMs =
    state?.config.timeoutMs ?? workspace.config.critic?.timeoutMs ?? CRITIC_CALL_TIMEOUT_MS;
  const budget = await readFeatureCriticBudget(workspace, feature, {
    maxCalls: workspace.config.critic?.maxCalls ?? CRITIC_MAX_CALLS,
  });
  if (!budget.ok) return AVAILABLE;
  if (featureCriticBudgetGap(budget.value.budget, timeoutMs))
    return { available: false, reason: "The independent review budget is spent." };
  if (state && relaunchBlocked(state, subject, selected.value.phase))
    return {
      available: false,
      reason: "VISP's independent reviewer failed twice on this source.",
    };
  return AVAILABLE;
}

/** The step when VISP's reviewer cannot run again: hand what remains to the human reviewer. */
export function reviewerHandoff(
  feature: string,
  capacity: ReviewerCapacity,
  remaining: "findings" | "assessment",
) {
  return {
    action: "fix" as const,
    completion: "handoff" as const,
    command: `visp pr --feature ${feature}`,
    objective: `${capacity.reason ?? "VISP's independent reviewer cannot run again."} Fix what you can and rerun your checks, then run visp pr to hand the remaining ${remaining} to a human reviewer`,
  };
}
