import { ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { featureCriticCapacity, readFeatureCriticBudget } from "./critic-budget.js";
import type { CriticState } from "./critic-model.js";
import { missingCriticSetup } from "./critic-policy.js";
import { type CriticSelection, criticSelection, readCriticState } from "./critic-store.js";
import type { ProductSelection } from "./store.js";

/** An early consultation shares the selection's budget and always leaves a product call. */
export function understandingReservationGap(
  selected: CriticSelection,
  state: CriticState,
  retryAfter: string | undefined,
  remaining: number,
) {
  if (
    state.attempts.some((attempt) => attempt.phase === "understanding" && attempt.id !== retryAfter)
  )
    return "Understanding consultation already used; address its findings and build, without another design-approval cycle";
  if (!beforeImplementation(selected))
    return "Understanding review belongs before slice implementation; review the actual product now";
  if (remaining < 2)
    return "Keep the remaining critic call for product review; use the worker's understanding review before implementation";
  return undefined;
}

function beforeImplementation(selected: CriticSelection) {
  const task = selected.slice?.id;
  return (
    !!task &&
    selected.record.state.status === "active" &&
    selected.record.state.slices[task]?.status === "pending" &&
    !selected.record.state.executions.some((execution) => execution.task === task)
  );
}

/** Read-only scheduling. Completed/unavailable consultations hand back to the worker. */
export async function criticUnderstanding(workspace: WorkspaceState, input: ProductSelection) {
  const selected = await criticSelection(workspace, { ...input, phase: "understanding" });
  if (!selected.ok) return selected;
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  const state = stored.value.state;
  if (
    selected.value.record.state.criticEnabled === false ||
    (!state && !missingCriticSetup(selected.value.record.state))
  )
    return ok(undefined);
  const attempt = state?.attempts.findLast(
    (entry) => entry.phase === "understanding" && (entry.intent ?? state.intent) === state.intent,
  );
  if (!attempt || !state) return ok(undefined);
  const command = `visp critic --feature ${selected.value.selection.feature} --task ${selected.value.slice?.id} --phase understanding`;
  const disposition = consultationDisposition(state, attempt);
  const budget = await readFeatureCriticBudget(workspace, state.feature, state.config);
  if (!budget.ok) return budget;
  const capacity = featureCriticCapacity(budget.value.budget, state.config.timeoutMs);
  return ok({
    ...disposition,
    command:
      disposition.status === "pending"
        ? command
        : `${command} ${state.config.transport === "native" ? "--preflight" : "--dispatch"}`,
    callsUsed: capacity.callsUsed,
    callsRemaining: capacity.callsRemaining,
    featureBudget: capacity,
    ...consultationFindings(attempt),
    evidenceRequest: attempt.response?.evidenceRequest,
    guidance:
      "Apply consequential feedback or supply counterevidence in the existing brief, then build. No design consensus loop or product-quality credit. Research and graph inspection should resolve concrete uncertainties. Product review remains required.",
  });
}

function consultationFindings(attempt: CriticState["attempts"][number] | undefined) {
  const response = attempt?.response ?? attempt?.advisoryResponse;
  return {
    findings: response?.review.feedback?.findings ?? [],
    ...(attempt?.advisoryResponse
      ? {
          advisory:
            "Late consultation; unaccepted advice only. Validate these questions before adopting them. It provides no quality credit and the call remains spent.",
        }
      : {}),
  };
}

function consultationDisposition(state: CriticState, attempt: CriticState["attempts"][number]) {
  if (attempt.status === "pending" && Date.now() <= attempt.startedAt + state.config.timeoutMs)
    return {
      requiredBeforeWork: false,
      status: "pending" as const,
      reason: "Understanding critic review is pending",
    };
  return {
    requiredBeforeWork: false,
    status: attempt.status === "reviewed" ? ("reviewed" as const) : ("unavailable" as const),
    reason:
      attempt.message ??
      (attempt.status === "pending"
        ? "Understanding deadline expired; reservation remains spent"
        : undefined),
  };
}

export function phaseReviewGap(
  selected: CriticSelection,
  state: CriticState,
  hasObservedProduct: boolean,
  retryAfter: string | undefined,
  remaining: number,
) {
  if (selected.phase === "understanding")
    return understandingReservationGap(selected, state, retryAfter, remaining);
  if (hasObservedProduct) return undefined;
  if (selected.record.state.executions.length || selected.record.state.captureRuns.length)
    return "Recorded evidence exists but does not match the current source, brief contract, runtime or execution environment. Inspect visp review for stale evidence; use the same execution environment (including the resolved browser). Do not rebuild the product or repeatedly recapture unchanged states to repair this mismatch.";
  return "Build a usable slice and record applicable checks or images before product critic review";
}
