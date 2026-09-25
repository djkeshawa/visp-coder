import { ok } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { applicableExecutions } from "./assessment.js";
import { candidatePath } from "./candidate.js";
import { sliceExecutionCheckIds } from "./corrections.js";
import {
  featureCriticBudgetGap,
  featureCriticCapacity,
  readFeatureCriticBudget,
  unconfiguredCriticSpending,
} from "./critic-budget.js";
import type { CriticPhase, CriticResponse, CriticState } from "./critic-model.js";
import { CRITIC_SETUP_GAP, missingCriticSetup } from "./critic-policy.js";
import { criticRecovery } from "./critic-recovery.js";
import { criticSelection, readCriticState } from "./critic-store.js";
import { needsBrowser } from "./environment.js";
import { latestCurrentJourneys } from "./evidence-references.js";
import { captureSchema } from "./images.js";
import type { ProductSlice, ProductState } from "./model.js";
import type { ProductRecord } from "./store.js";
import { productSourceDigest } from "./subject.js";

/** Transport/submission handling is not the same as accepting returned feedback. */
export function rejectedCriticReview(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("lifecycle" in value)) return false;
  const lifecycle = value.lifecycle;
  return (
    !!lifecycle &&
    typeof lifecycle === "object" &&
    "acceptedReview" in lifecycle &&
    lifecycle.acceptedReview === false &&
    "status" in lifecycle &&
    lifecycle.status === "invocation-failed"
  );
}
export async function criticStatus(
  workspace: WorkspaceState,
  selection: { feature?: string; task?: string; phase?: CriticPhase },
) {
  const selected = await criticSelection(workspace, selection);
  if (!selected.ok) return selected;
  if (selected.value.record.state.status === "historical-complete")
    return ok({
      enabled: false,
      ...manualPolicyStatus(selected.value.record.state),
    } as const);
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  const state = stored.value.state;
  if (!state) return unconfiguredStatus(workspace, selected.value);
  const subject = await productSourceDigest(workspace, selected.value.record.brief);
  if (!subject.ok) return subject;
  const { hasObservedProduct, renderedEvidence } = criticEvidence(
    workspace,
    selected.value,
    subject.value,
  );
  const budget = await readFeatureCriticBudget(workspace, state.feature, state.config);
  if (!budget.ok) return budget;
  const capacity = featureCriticCapacity(budget.value.budget, state.config.timeoutMs);
  const budgetGap = featureCriticBudgetGap(budget.value.budget, state.config.timeoutMs);
  const summary = criticSummary(
    workspace,
    state,
    subject.value,
    selected.value.contract,
    selected.value.intent,
    selected.value.phase,
    capacity,
  );
  return ok({
    ...summary,
    selectionCallsUsed: state.attempts.length,
    featureBudget: capacity,
    stopped: summary.stopped ?? (summary.next === "normal-acceptance" ? undefined : budgetGap),
    next: budgetGap && summary.next === "review" ? "unresolved" : summary.next,
    ...(state.disabled && selected.value.record.state.criticEnabled !== false
      ? {
          enabled: true,
          next: "unresolved",
          stopped:
            "Legacy task disable conflicts with feature policy; use critic --reconcile --reason <reason> to preserve calls and resume",
        }
      : {}),
    ...(selected.value.record.state.criticEnabled === false
      ? { enabled: false, stopped: "feature-critic-disabled" }
      : {}),
    ...manualPolicyStatus(selected.value.record.state),
    hasObservedProduct,
    renderedEvidence,
  });
}

async function unconfiguredStatus(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
) {
  const spending = await unconfiguredCriticSpending(workspace, selected.record.brief.feature);
  if (!spending.ok) return spending;
  if (!missingCriticSetup(selected.record.state))
    return ok({
      enabled: false,
      ...spending.value,
      ...manualPolicyStatus(selected.record.state),
    } as const);
  const subject = await productSourceDigest(workspace, selected.record.brief);
  if (!subject.ok) return subject;
  return ok({
    enabled: true,
    callsUsed: 0,
    ...spending.value,
    next: "unresolved",
    transport: "native",
    stopped: CRITIC_SETUP_GAP,
    gaps: [CRITIC_SETUP_GAP],
    command: undefined,
    recovery: undefined,
    evidenceRequest: undefined,
    ...criticEvidence(workspace, selected, subject.value),
  });
}

function criticEvidence(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  subject: string,
) {
  const hasObservedProduct = observedProduct(workspace, selected.record, selected.slice, subject);
  const renderedEvidence = {
    relevant: needsBrowser(selected.record.brief, selected.slice),
    recorded: selected.record.state.captures.some((input) => {
      const capture = captureSchema.safeParse(input);
      return capture.success && capture.data.subjectDigest === subject;
    }),
  };
  return { hasObservedProduct, renderedEvidence };
}

export function observedProduct(
  workspace: WorkspaceState,
  record: ProductRecord,
  slice: ProductSlice | undefined,
  subject: string,
) {
  const checks = slice ? sliceExecutionCheckIds(workspace, record, slice, subject) : undefined;
  return (
    applicableExecutions(record, subject, slice).some(
      (execution) => !checks || checks.has(execution.check),
    ) || latestCurrentJourneys(record, subject, slice?.id).length > 0
  );
}

function criticSummary(
  workspace: WorkspaceState,
  state: CriticState,
  subject: string,
  contract: string,
  intent: string,
  phase: CriticPhase,
  capacity: ReturnType<typeof featureCriticCapacity>,
) {
  const current = currentAttempt(state, subject, contract, phase);
  const last =
    current ?? state.attempts.findLast((attempt) => (attempt.phase ?? "product") === phase);
  const reason = stopReason(state, subject, contract, intent, phase);
  const feedback = (last?.response ?? last?.advisoryResponse)?.review.feedback;
  const needsWork =
    current &&
    last?.status === "reviewed" &&
    (phase === "understanding" ||
      hasFindings(last.response) ||
      (!last.sourceOnly && !!last.gaps?.length));
  return {
    enabled: !state.disabled,
    phase,
    model: state.config.model,
    reasoningEffort: state.config.reasoningEffort,
    transport: state.config.transport ?? "sampling",
    config: { ...state.config, maxCalls: capacity.limit },
    callsUsed: capacity.callsUsed,
    lifecycle: criticLifecycle(last),
    recovery: criticRecovery(state, phase, capacity.reservableCalls),
    callsRemaining: capacity.callsRemaining,
    reviewCapacity: reviewCapacity(capacity),
    assessmentCurrent: !!current && current.status === "reviewed" && !current.sourceOnly,
    sourceOnly: last?.sourceOnly === true,
    stopped: reason,
    subjectDigest: subject,
    preferredCandidate: state.preferredCandidate,
    candidates: state.attempts.map((a) => ({
      id: a.candidate,
      path: candidatePath(workspace, state.feature, a.candidate),
      subject: a.subject,
      status: a.status,
      phase: a.phase ?? "product",
    })),
    next: nextAction(
      !!needsWork,
      reason,
      !!current && last?.status === "reviewed" && !current.sourceOnly,
    ),
    gaps: last?.gaps ?? [],
    comparisons: last?.response?.comparison ?? [],
    findings: feedback?.findings ?? [],
    advice: criticAdvice(last, !!current),
    ...(last?.advisoryResponse
      ? { advisory: "Late understanding advice; not an accepted review or quality credit" }
      : {}),
    evidenceRequest: last?.response?.evidenceRequest,
    command: needsWork
      ? `visp work --feature ${state.feature}${state.task ? ` --task ${state.task}` : ""}`
      : undefined,
    limitation:
      "Critic judgments are advisory evidence, not automatic acceptance or proof of the best candidate.",
  };
}

function criticAdvice(last: CriticState["attempts"][number] | undefined, current: boolean) {
  const feedback = (last?.response ?? last?.advisoryResponse)?.review.feedback;
  if (!feedback?.summary && !feedback?.limitations?.length) return undefined;
  return {
    summary: feedback.summary,
    limitations: feedback.limitations ?? [],
    subjectDigest: last?.subject,
    current: current && last?.status === "reviewed",
  };
}

function criticLifecycle(last: CriticState["attempts"][number] | undefined) {
  return {
    configured: true,
    reserved: !!last,
    failureKind: last?.failureKind,
    invocationClaimed: last?.execution?.claimed ?? false,
    adapterCall:
      last?.execution?.provenance === "adapter-observed" ? last.execution.adapterCall : undefined,
    invoked: last?.execution?.invoked ?? null,
    invocationNote:
      "A persisted claim prevents replay. Adapter call timing measures the host method, not provider startup or billing. Interrupted or failed transport may leave actual model invocation unknown; do not retry automatically.",
    returned: last?.execution?.returned ?? !!last?.response,
    acceptedReview: last?.status === "reviewed",
    provenance: last?.execution?.provenance ?? "host-reported",
    status: last?.status === "unavailable" ? "invocation-failed" : (last?.status ?? "setup-needed"),
  };
}

function reviewCapacity(capacity: ReturnType<typeof featureCriticCapacity>) {
  return {
    limit: capacity.limit,
    understandingCalls: capacity.understandingCalls,
    productCalls: capacity.productCalls,
    remainingCalls: capacity.callsRemaining,
    reservableCalls: capacity.reservableCalls,
    canReviewAndRecheck: capacity.reservableCalls >= 2,
    guidance:
      "Design consultation, product review and a fresh repair review each consume a call. A two-call limit cannot cover all three. Source changes need fresh product evidence. If critic capacity is exhausted, continue baseline host review and disclose the independent-review limitation. Budgets never increase automatically.",
  };
}

export function hasFindings(response: CriticResponse | undefined) {
  return (
    !!response &&
    (!!response.evidenceRequest ||
      response.review.feedback?.findings.some((f) => f.required) ||
      response.review.feedback?.dimensions.some((d) =>
        ["failed", "unclear", "unavailable"].includes(d.status),
      ) ||
      response.review.assessments.some((a) => a.status !== "satisfied"))
  );
}

export function stopReason(
  state: CriticState,
  subject: string,
  contract: string,
  intent: string,
  phase: CriticPhase = "product",
  retryAfter?: string,
): string | undefined {
  if (state.disabled) return "disabled";
  if (state.intent !== intent)
    return "intent-changed; reconcile the validated brief with visp critic --reconcile --reason <reason>; spent calls remain spent";
  const last = state.attempts.findLast(
    (attempt) => (attempt.intent ?? state.intent) === state.intent,
  );
  if (
    last?.status === "pending" &&
    ((last.phase ?? "product") === phase || Date.now() <= last.startedAt + state.config.timeoutMs)
  )
    return Date.now() > last.startedAt + state.config.timeoutMs
      ? "interrupted-review; reservation remains spent"
      : "review-in-progress";
  const current = currentAttempt(state, subject, contract, phase);
  if (
    current?.status === "reviewed" &&
    !current.sourceOnly &&
    !hasFindings(current.response) &&
    !current.gaps?.length
  )
    return undefined;
  if (
    last?.status === "unavailable" &&
    (last.phase ?? "product") === phase &&
    last.id !== retryAfter
  )
    return `Previous critic attempt unavailable: ${last.message ?? "review unavailable"}. No new invocation was attempted. Inspect critic recovery when useful; otherwise continue baseline host review and disclose this independent-review limitation.`;
  return undefined;
}

function currentAttempt(state: CriticState, subject: string, contract: string, phase: CriticPhase) {
  return state.attempts.findLast(
    (attempt) =>
      (attempt.phase ?? "product") === phase &&
      (attempt.intent ?? state.intent) === state.intent &&
      attempt.subject === subject &&
      attempt.contract === contract,
  );
}

function nextAction(needsWork: boolean, reason: string | undefined, reviewed: boolean) {
  if (needsWork) return "worker";
  if (reason) return "unresolved";
  return reviewed ? "normal-acceptance" : "review";
}

function manualPolicyStatus(state: ProductState) {
  return state.criticManual
    ? { manual: true, mode: state.criticEnabled === false ? "manual" : "both" }
    : {};
}
