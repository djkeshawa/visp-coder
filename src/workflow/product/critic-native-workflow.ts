import { vispError } from "../../core/errors.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import {
  featureCriticBudgetGap,
  featureCriticCapacity,
  readFeatureCriticBudget,
  unconfiguredCriticSpending,
} from "./critic-budget.js";
import { type CriticRequest, type CriticState, isEarlyCriticGap } from "./critic-model.js";
import { criticDelegation, criticDispatchSetup, nativeCapabilityGaps } from "./critic-native.js";
import { criticPacket, currentReviewGap, packetHasImages } from "./critic-packet.js";
import { CRITIC_SETUP_GAP, missingCriticSetup } from "./critic-policy.js";
import { criticRecoveryAuthorizationGap, criticRetryError } from "./critic-recovery.js";
import { reserveReview } from "./critic-reservation.js";
import { finishReview } from "./critic-result.js";
import { observedProduct, stopReason } from "./critic-status.js";
import { criticSelection, readCriticState, saveCriticState } from "./critic-store.js";
import { phaseReviewGap } from "./critic-understanding.js";
import { runProductReviewerHandoff } from "./reviewer-handoff.js";
import { withProductMutation } from "./runtime.js";

export function prepareNative(
  workspace: WorkspaceState,
  request: CriticRequest,
): Promise<Result<unknown>> {
  return withProductMutation(workspace, async () => {
    const reserved = await reserveReview(workspace, request);
    if (!reserved.ok) return reserved;
    const handoff = reserved.value.handoff;
    if (!handoff) return err(vispError("ARTIFACT_INVALID", "Native reservation has no handoff"));
    const { responsePath, capabilitiesPath } = handoff;
    const submissionArgs = [
      "critic",
      "--feature",
      reserved.value.selection.feature,
      ...(reserved.value.selection.task ? ["--task", reserved.value.selection.task] : []),
      "--attempt",
      reserved.value.id,
      "--capabilities",
      capabilitiesPath,
      "--submit",
      responsePath,
    ];
    const submissionCommand = `visp ${submissionArgs.map(shellArgument).join(" ")}`;
    return ok({
      attempt: reserved.value.id,
      phase: request.phase ?? "product",
      sourceOnly: request.sourceOnly === true,
      ...handoff,
      expiresAt: reserved.value.expiresAt,
      provenance: "host-reported; not authenticated",
      submit: submissionCommand,
      selection: reserved.value.selection,
      submission: {
        responsePath,
        capabilitiesPath,
        args: submissionArgs,
        failureCommand: `visp critic --feature ${reserved.value.selection.feature}${reserved.value.selection.task ? ` --task ${reserved.value.selection.task}` : ""} --attempt ${reserved.value.id} --failure <actual-host-failure>`,
        command: submissionCommand,
        response:
          "Save the reviewer JSON unchanged. No envelope construction, field rewriting, or internal source inspection is needed.",
        host: "VISP created capabilitiesPath with unknown (null) values. After invocation, replace them with the actual session's harness, model, effort, fresh context, read-only restrictions, image access and delegation authorization. The template cannot pass validation. Do not copy preflight/requested settings as observations; report --failure if the host cannot establish them.",
      },
    });
  });
}

export function submitNative(
  workspace: WorkspaceState,
  request: CriticRequest,
): Promise<Result<unknown>> {
  return withProductMutation(workspace, async () => {
    const selected = await criticSelection(workspace, request);
    if (!selected.ok) return selected;
    if (selected.value.record.state.status === "historical-complete")
      return err(
        vispError(
          "STAGE_BLOCKED",
          "Historical features are read-only; create a new feature for critic evaluation",
        ),
      );
    const stored = await readCriticState(workspace, selected.value);
    if (!stored.ok) return stored;
    if (isEarlyCriticGap(request))
      return recordEarlyGap(
        workspace,
        selected.value,
        stored.value,
        request.failure,
        request.failureKind,
      );
    return completeNativeSubmission(workspace, request, stored.value.state);
  });
}

function completeNativeSubmission(
  workspace: WorkspaceState,
  request: CriticRequest,
  state: CriticState | undefined,
): Promise<Result<unknown>> | Result<unknown> {
  const result = nativeSubmission(request);
  if (!result) return err(vispError("ARTIFACT_INVALID", "submit requires result"));
  const attempt = state?.attempts.find((a) => a.id === result.attempt);
  if (attempt?.transport !== "native")
    return err(vispError("STATE_BUSY", "No native reservation matches this result"));
  if (request.notInvoked && (attempt.execution?.claimed || attempt.execution?.invoked))
    return err(
      vispError(
        "STATE_BUSY",
        "A claimed invocation cannot be reported as not invoked through native submission",
      ),
    );
  if (attempt.execution?.claimed && result.response !== undefined)
    return err(
      vispError(
        "STATE_BUSY",
        "An attached adapter owns this invocation; a native submission cannot impersonate its returned review",
      ),
    );
  if (request.phase && request.phase !== (attempt.phase ?? "product"))
    return err(vispError("ARTIFACT_INVALID", "Submission phase differs from the reserved review"));
  const failure = submissionFailure(request, result, state, attempt);
  return finishReview(
    workspace,
    { ...request, phase: attempt.phase ?? "product" },
    result.attempt,
    { ...result, response: result.response },
    failure,
  );
}

async function recordEarlyGap(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
  stored: { state?: CriticState; text?: string },
  reason: string,
  category = "setup-unverified",
): Promise<Result<unknown>> {
  const state = stored.state;
  if (!state)
    return err(
      vispError("CONFIG_INVALID", "Configure the reviewer host before reporting its availability"),
    );
  if (
    state.attempts.some(
      (attempt) => attempt.phase === "understanding" || attempt.status === "pending",
    )
  )
    return err(
      vispError(
        "STATE_BUSY",
        "A consultation or pending attempt already exists; use --attempt to report its result",
      ),
    );
  const saved = await saveCriticState(workspace, selected, stored.text, {
    ...state,
    understandingGap: {
      reason: reason,
      intent: selected.intent,
      provenance: "host-reported",
      category,
    },
  });
  if (!saved.ok) return saved;
  const budget = await readFeatureCriticBudget(workspace, state.feature, state.config);
  if (!budget.ok) return budget;
  return ok({
    action: "worker",
    status: category === "setup-unverified" ? "setup-needed" : "unavailable",
    callsUsed: featureCriticCapacity(budget.value.budget, state.config.timeoutMs).callsUsed,
    reason: reason,
    category,
    command: `visp work --feature ${selected.selection.feature}${selected.selection.task ? ` --task ${selected.selection.task}` : ""}`,
    limitation:
      "Early consultation unavailable; no review credit and no call reserved. Implement the slice, then obtain the required product review.",
  });
}

function earlyUnavailableCommand(selection: { feature: string; task?: string }) {
  return `visp critic --feature ${selection.feature}${selection.task ? ` --task ${selection.task}` : ""} --phase understanding --failure-kind <category> --failure <actual-host-gap>`;
}

export async function nativePreflight(workspace: WorkspaceState, request: CriticRequest) {
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  if (selected.value.record.state.status === "historical-complete")
    return ok({
      status: "unavailable",
      ready: false,
      enabled: false,
      gaps: ["Historical features are read-only"],
    });
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  const state = stored.value.state;
  if (!state || selected.value.record.state.criticEnabled === false)
    return unavailablePreflight(workspace, selected.value);
  const retryError = criticRetryError(state, request, selected.value.phase);
  if (retryError) return err(vispError("STATE_BUSY", retryError));
  const handoff = await runProductReviewerHandoff(workspace, selected.value.selection);
  if (!handoff.ok) return handoff;
  const packet = await criticPacket(
    workspace,
    selected.value,
    state,
    handoff.value,
    request.question,
    request.sourceOnly,
  );
  if (!packet.ok) return packet;
  const gaps = nativeCapabilityGaps(
    state.config,
    request.capabilities,
    packetHasImages(packet.value),
  );
  const stop = stopReason(
    state,
    handoff.value.subjectDigest,
    selected.value.contract,
    selected.value.intent,
    selected.value.phase,
    request.retryAfter,
  );
  gaps.push(
    ...[
      criticRecoveryAuthorizationGap(request),
      currentReviewGap(packet.value, selected.value),
      stop,
    ].filter((gap): gap is string => !!gap),
  );
  const budget = await readFeatureCriticBudget(workspace, state.feature, state.config);
  if (!budget.ok) return budget;
  const capacity = featureCriticCapacity(budget.value.budget, state.config.timeoutMs);
  const budgetGap = featureCriticBudgetGap(budget.value.budget, state.config.timeoutMs);
  if (budgetGap) gaps.push(budgetGap);
  const phaseGap = phaseReviewGap(
    selected.value,
    state,
    observedProduct(
      workspace,
      selected.value.record,
      selected.value.slice,
      handoff.value.subjectDigest,
    ),
    request.retryAfter,
    capacity.reservableCalls,
  );
  if (phaseGap && !request.sourceOnly) gaps.push(phaseGap);
  return ok({
    ...preflightSummary(selected.value, state, request, gaps, packetHasImages(packet.value)),
    config: { ...state.config, maxCalls: capacity.limit },
    callsUsed: capacity.callsUsed,
    callsRemaining: capacity.callsRemaining,
    featureBudget: capacity,
  });
}

async function unavailablePreflight(
  workspace: WorkspaceState,
  selected: import("./critic-store.js").CriticSelection,
) {
  const spending = await unconfiguredCriticSpending(workspace, selected.record.brief.feature);
  if (!spending.ok) return spending;
  if (selected.record.state.criticEnabled === false)
    return ok({
      status: "unavailable",
      ready: false,
      enabled: false,
      gaps: ["Feature critic is off; only an explicit user request should enable it"],
      ...spending.value,
    });
  return ok({
    status: "setup-needed",
    ...spending.value,
    next: "Configure the critic, then run visp critic --preflight",
    ready: false,
    gaps: [
      missingCriticSetup(selected.record.state)
        ? CRITIC_SETUP_GAP
        : "No critic configured for this selection",
    ],
  });
}

function preflightSummary(
  selected: import("./critic-store.js").CriticSelection,
  state: CriticState,
  request: CriticRequest,
  gaps: string[],
  hasImages: boolean,
) {
  return {
    status: !request.capabilities ? "setup-needed" : gaps.length ? "unavailable" : "ready",
    ready: gaps.length === 0,
    hostSetup: nativeHostSetup(selected, state.config, hasImages),
    phase: selected.phase,
    sourceOnly: request.sourceOnly === true,
    prepareCommand: `visp critic --feature ${selected.selection.feature}${selected.selection.task ? ` --task ${selected.selection.task}` : ""} --phase ${selected.phase}${request.sourceOnly ? " --source-only" : ""} --prepare --capabilities -`,
    config: state.config,
    gaps,
    capabilityProvenance: "host-reported; not independently verified",
    requiresImages: hasImages,
    next: !request.capabilities
      ? "Inspect host capabilities and supply --capabilities to preflight; no availability decision has been made"
      : gaps.length
        ? "Resolve the capability/evidence gap; do not reserve or launch a critic"
        : "prepare, delegate once, submit unchanged result",
  };
}

function nativeHostSetup(
  selected: import("./critic-store.js").CriticSelection,
  config: CriticState["config"],
  hasImages: boolean,
) {
  return {
    dispatch: criticDispatchSetup(config),
    delegation: criticDelegation(config, hasImages),
    ...(selected.phase === "understanding"
      ? { reportUnavailable: earlyUnavailableCommand(selected.selection) }
      : {
          recovery:
            "Independent critic unavailable. Continue baseline host review while resolving the host gap; disclose the limitation. If an attempt is already reserved, record its actual failure with --attempt; an understanding-gap report cannot replace product review.",
          retry: `visp critic --feature ${selected.selection.feature}${selected.selection.task ? ` --task ${selected.selection.task}` : ""} --phase product --preflight`,
        }),
    beforePrepare:
      "Confirm the actual host can delegate this packet and images with the configured model, effort and restricted tools, and that delegation is authorized. If refused, report delegationAllowed:false; do not reserve or bypass the refusal.",
    capabilitiesExample: {
      harness: config.harness,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      freshContext: true,
      readOnly: true,
      images: hasImages,
      delegationAllowed: false,
    },
    provenance:
      "Example contains requested settings, not verified capabilities. Replace with actual observations; a boolean cannot prove human authorization.",
  };
}

function nativeSubmission(request: CriticRequest) {
  if (request.result) return request.result;
  if (request.attempt && request.failure)
    return {
      attempt: request.attempt,
      model: request.capabilities?.model ?? "unavailable",
      context: "unavailable" as const,
      response: undefined,
      failure: request.failure,
    };
  if (!request.attempt || !request.capabilities || request.response === undefined) return undefined;
  return {
    attempt: request.attempt,
    model: request.capabilities.model,
    reasoningEffort: request.capabilities.reasoningEffort,
    context: request.capabilities.freshContext ? ("fresh" as const) : ("current" as const),
    response: request.response,
    failure: undefined,
  };
}
function rawCapabilityFailure(
  request: CriticRequest,
  config: import("./critic-model.js").CriticConfig | undefined,
  requiresImages: boolean,
) {
  if (request.response === undefined || !config) return undefined;
  return nativeCapabilityGaps(config, request.capabilities, requiresImages).join(" ") || undefined;
}

function submissionFailure(
  request: CriticRequest,
  result: NonNullable<ReturnType<typeof nativeSubmission>>,
  state: import("./critic-model.js").CriticState | undefined,
  attempt: import("./critic-model.js").CriticState["attempts"][number],
) {
  return (
    result.failure ?? rawCapabilityFailure(request, state?.config, attempt.requiresImages ?? false)
  );
}

function shellArgument(value: string) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
