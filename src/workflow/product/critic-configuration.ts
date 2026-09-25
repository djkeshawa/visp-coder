import { vispError } from "../../core/errors.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { readFeatureCriticBudget } from "./critic-budget.js";
import type { CriticConfig, CriticRequest, CriticState } from "./critic-model.js";
import { type CriticSelection, saveCriticState } from "./critic-store.js";

/** Configure a selection without resetting the feature's existing budget or history. */
export async function configureCritic(
  workspace: WorkspaceState,
  request: CriticRequest,
  selected: CriticSelection,
  stored: { text: string | undefined; state?: CriticState },
): Promise<Result<unknown>> {
  const previous = stored.state;
  if (previous && stored.text !== undefined) {
    if (
      !previous.disabled &&
      hashValue(previous.config) === hashValue(request.config) &&
      previous.intent === selected.intent
    )
      return ok({ configured: true, unchanged: true });
    return err(
      vispError(
        "STAGE_BLOCKED",
        "A critic experiment already exists for this selection. Budgets cannot reset through reconfiguration; use a fresh feature for another experiment.",
      ),
    );
  }
  const featureBudget = await readFeatureCriticBudget(
    workspace,
    selected.selection.feature,
    request.config as CriticConfig,
  );
  if (!featureBudget.ok) return featureBudget;
  if (
    featureBudget.value.text !== undefined &&
    request.config?.maxCalls !== featureBudget.value.budget.maxCalls
  )
    return err(
      vispError(
        "STAGE_BLOCKED",
        "The feature critic budget is pinned; a slice configuration cannot change its call limit",
        {
          recovery: `Use maxCalls ${featureBudget.value.budget.maxCalls} for this feature; spent capacity cannot be reset`,
        },
      ),
    );
  const state: CriticState = {
    version: 1,
    root: hashValue(workspace.paths.root),
    feature: selected.selection.feature,
    task: selected.selection.task,
    contract: selected.contract,
    intent: selected.intent,
    config: request.config as CriticConfig,
    disabled: false,
    attempts: [],
  };
  const saved = await saveCriticState(workspace, selected, stored.text, state);
  return saved.ok
    ? ok({
        configured: true,
        config: state.config,
        dispatch:
          state.config.transport === "native"
            ? "host-native prepare/submit"
            : "explicit host sampling only",
        cost: "Calls, deadline, image bytes and findings remain bounded. VISP imposes no text or token ceiling; context limits and billing belong to the host.",
      })
    : saved;
}
