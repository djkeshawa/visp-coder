import type { CriticPhase, CriticRequest, CriticState } from "./critic-model.js";

/** A fresh attempt, never a replay or an automatic waiver of a host refusal. */
export function criticRetryError(state: CriticState, request: CriticRequest, phase: CriticPhase) {
  if (!request.retryAfter) return undefined;
  const last = state.attempts.at(-1);
  if (
    !last ||
    last.id !== request.retryAfter ||
    last.status !== "unavailable" ||
    (last.phase ?? "product") !== phase ||
    (last.intent ?? state.intent) !== state.intent
  )
    return "retry-after must name the latest unavailable attempt for this intent and phase; pending or already retried attempts cannot be replayed";
  return undefined;
}

export function criticRecovery(state: CriticState, phase: CriticPhase, remaining: number) {
  const last = state.attempts.at(-1);
  if (last?.status !== "unavailable" || (last.phase ?? "product") !== phase) return undefined;
  const available = remaining >= (phase === "understanding" ? 2 : 1);
  const base = `visp critic --feature ${state.feature}${state.task ? ` --task ${state.task}` : ""} --phase ${phase}`;
  return {
    after: last.id,
    failureKind: last.failureKind ?? "unclassified-legacy-failure",
    previousFailure: last.message,
    invocation: last.execution?.invoked === false ? "reported-not-invoked" : "possibly-invoked",
    provenance: last.execution?.provenance ?? "host-reported",
    availableWithinBudget: available,
    command: available
      ? `${base} --preflight --retry-after ${last.id} --reason "<resolved blocker and authorization for a fresh attempt>" --capabilities <project-file>`
      : undefined,
    guidance: available
      ? "Use authorization already supplied in this task; do not request it again for the same scope. Confirm the blocker is resolved and the host permits a fresh call. Retry preflight is read-only; use the same retry-after/reason with prepare or an attached adapter's dispatch. The old attempt remains spent. A possibly invoked call may have incurred cost; never retry it automatically. Reuse unchanged evidence; worker approval cannot resolve a missing critic."
      : "Insufficient remaining budget for this retry. Preserve the remaining call for product review when applicable; no automatic budget reset or repeated worker approval.",
  };
}

export function criticRecoveryAuthorizationGap(request: CriticRequest) {
  return request.retryAfter && request.capabilities?.delegationAllowed !== true
    ? "Recovery requires current host delegation authorization; requested settings alone do not establish it"
    : undefined;
}
