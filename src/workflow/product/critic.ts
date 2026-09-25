import { configureCritic } from "./critic-configuration.js";
import type { CriticPacket } from "./critic-packet.js";
import { withProductMutation } from "./runtime.js";

export type { CriticPacket } from "./critic-packet.js";

import { fromUnknown, vispError } from "../../core/errors.js";
import { applyFileTransaction } from "../../core/file-transaction.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { restoreCandidate } from "./candidate.js";
import { invokeCriticOnce } from "./critic-invocation.js";
import {
  type CriticConfig,
  type CriticRequest,
  criticRequestSchema,
  isEarlyCriticGap,
} from "./critic-model.js";
import { nativePreflight, prepareNative, submitNative } from "./critic-native-workflow.js";
import { setFeatureCriticPolicy } from "./critic-policy.js";
import { reserveReview } from "./critic-reservation.js";
import { finishReview } from "./critic-result.js";
import { planCriticRevision } from "./critic-revision.js";
import { criticStatus } from "./critic-status.js";
import { criticSelection, readCriticState, recordGuards, saveCriticState } from "./critic-store.js";

/** Host owns provider credentials and billing. Exactly one call; no tools or recursive delegation. */
export interface ProductCriticHost {
  /** Read-only capability discovery. Does not invoke a model or reserve a call. */
  inspect?: (
    options: CriticConfig & { signal: AbortSignal; requiresImages: boolean },
  ) => Promise<import("./critic-model.js").CriticRequest["capabilities"] | { unavailable: string }>;
  review(
    packet: CriticPacket,
    options: CriticConfig & { signal: AbortSignal },
  ): Promise<{
    model: string;
    response: unknown;
    truncated?: boolean;
    reasoningEffort?: CriticConfig["reasoningEffort"];
    context?: "fresh" | "current" | "unavailable";
    outputTokens?: number;
  }>;
}
export type CriticAdapter = ProductCriticHost | { unavailable: string };

export async function runProductCritic(
  workspace: WorkspaceState,
  input: unknown,
  host?: CriticAdapter,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  if (signal?.aborted)
    return err(vispError("STATE_BUSY", "Critic operation cancelled before reservation"));
  const parsed = criticRequestSchema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .filter((issue) => issue.path[0] === "capabilities")
      .map((issue) => issue.path.slice(1).join(".") || "capabilities");
    return err(
      vispError(
        "ARTIFACT_INVALID",
        fields.length
          ? `Host capability report has missing or invalid observations: ${[...new Set(fields)].join(", ")}. Fill the prepared capabilities.json with actual host facts; its unknown template and requested settings are not observations. No result was consumed or new call reserved.`
          : parsed.error.message,
      ),
    );
  }
  const request = parsed.data;
  const modeError = normalizeCriticMode(request);
  if (modeError) return err(vispError("ARTIFACT_INVALID", modeError));
  const invalid = invalidRequest(request);
  if (invalid) return err(vispError("ARTIFACT_INVALID", invalid));
  if (request.operation === "status") return criticStatus(workspace, request);
  if (request.operation === "preflight") return inspectHost(workspace, request, host, signal);
  if (request.operation === "prepare") return prepareNative(workspace, request);
  if (request.operation === "submit") return submitNative(workspace, request);
  if (request.operation === "review") return dispatchCritic(workspace, request, host, signal);
  return withProductMutation(workspace, () => mutateCritic(workspace, request));
}

async function mutateCritic(
  workspace: WorkspaceState,
  request: CriticRequest,
): Promise<Result<unknown>> {
  if (request.operation === "set-policy") return setFeatureCriticPolicy(workspace, request);
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  if (selected.value.record.state.status === "historical-complete")
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Historical features are read-only; create a new feature for critic evaluation",
      ),
    );
  if (request.operation === "restore")
    return restoreCandidate(
      workspace,
      selected.value,
      request.candidate as string,
      request.expectedSubject as string,
    );
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok) return stored;
  if (request.operation === "disable")
    return err(
      vispError(
        "WORKFLOW_REPLACED",
        "Task-level --disable cannot bypass feature critic policy. Use --off without --task only for a user-requested feature opt-out; an unavailable review remains unresolved.",
      ),
    );
  if (request.operation === "reconcile") return reconcileCritic(workspace, request, selected.value);
  return configureCritic(workspace, request, selected.value, stored.value);
}

async function dispatchCritic(
  workspace: WorkspaceState,
  request: CriticRequest,
  host?: CriticAdapter,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  // Detect missing adapters before a reservation; no provider could have charged.
  if (!host || "unavailable" in host) return unavailableAdapter(workspace, request, host, signal);
  const inspected = await inspectHost(workspace, request, host, signal);
  if (!inspected.ok) return inspected;
  if (host.inspect) {
    const discovery = inspected.value as {
      ready: boolean;
      capabilities?: CriticRequest["capabilities"];
    };
    if (!discovery.ready) return inspected;
    request = { ...request, capabilities: discovery.capabilities };
  }
  if (signal?.aborted)
    return err(vispError("STATE_BUSY", "Critic operation cancelled before reservation"));
  const prepared = await withProductMutation(workspace, () => reserveReview(workspace, request));
  if (!prepared.ok) return prepared;
  const { packet, config, id, selection, expiresAt } = prepared.value;
  const invoked = await claimInvocation(workspace, { ...request, ...selection }, id);
  if (!invoked.ok) return invoked;
  const { response, failure, returnedAt, adapterCall } = await invokeCriticOnce(
    host,
    packet,
    config,
    expiresAt,
    signal,
  );
  return withProductMutation(workspace, () =>
    finishReview(
      workspace,
      { ...request, ...selection },
      id,
      response,
      failure,
      returnedAt,
      adapterCall,
    ),
  );
}

async function unavailableAdapter(
  workspace: WorkspaceState,
  request: CriticRequest,
  host: { unavailable: string } | undefined,
  signal?: AbortSignal,
): Promise<Result<unknown>> {
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  const discovery = await inspectHost(workspace, request, host, signal);
  return err(
    vispError(
      "CONFIG_INVALID",
      host?.unavailable ??
        "No reviewer adapter is attached. Follow the native handoff; host capability is not yet established and no call was spent.",
      {
        details: discovery.ok ? discovery.value : undefined,
        recovery: "visp critic --preflight",
      },
    ),
  );
}

/** Persist ownership before calling the host so interruption never permits automatic replay. */
function claimInvocation(workspace: WorkspaceState, request: CriticRequest, id: string) {
  return withProductMutation(workspace, async () => {
    const selected = await criticSelection(workspace, request);
    if (!selected.ok) return selected;
    const stored = await readCriticState(workspace, selected.value);
    if (!stored.ok) return stored;
    const state = stored.value.state;
    const attempt = state?.attempts.find((entry) => entry.id === id && entry.status === "pending");
    if (!state || !attempt || attempt.execution?.invoked || attempt.execution?.claimed)
      return err(
        vispError("STATE_BUSY", "Critic invocation is already claimed or no longer pending"),
      );
    return saveCriticState(workspace, selected.value, stored.value.text, {
      ...state,
      attempts: state.attempts.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              execution: {
                provenance: "adapter-observed" as const,
                claimed: true,
                returned: false,
              },
            }
          : entry,
      ),
    });
  });
}

async function inspectHost(
  workspace: WorkspaceState,
  request: CriticRequest,
  host?: CriticAdapter,
  signal?: AbortSignal,
) {
  const initial = await nativePreflight(workspace, request);
  if (!initial.ok || !host) return initial;
  if ("unavailable" in host)
    return ok({
      ...initial.value,
      status: "unavailable",
      ready: false,
      gaps: [host.unavailable],
      dispatchMethod: "native-handoff",
      capabilityProvenance: "adapter-observed",
    });
  if (!host.inspect) return initial;
  const discovery = initial.value as { config?: CriticConfig; requiresImages?: boolean };
  if (!discovery.config) return initial;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    if (signal?.aborted) throw new Error("Host capability inspection cancelled");
    const report = await Promise.race([
      host.inspect({
        ...discovery.config,
        signal: controller.signal,
        requiresImages: !!discovery.requiresImages,
      }),
      new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Host capability inspection timed out")),
          { once: true },
        ),
      ),
    ]);
    if (report && "unavailable" in report)
      return ok({
        ...initial.value,
        status: "unavailable",
        ready: false,
        gaps: [report.unavailable],
        capabilityProvenance: "adapter-observed",
      });
    const parsed = criticRequestSchema.safeParse({ ...request, capabilities: report });
    if (!parsed.success)
      return err(vispError("ARTIFACT_INVALID", "Host returned invalid capability information"));
    const inspected = await nativePreflight(workspace, parsed.data);
    return inspected.ok
      ? ok({
          ...inspected.value,
          capabilities: report,
          dispatchMethod: "attached-adapter",
          capabilityProvenance: "adapter-observed",
        })
      : inspected;
  } catch (cause) {
    return ok({
      ...initial.value,
      status: "setup-needed",
      ready: false,
      gaps: [fromUnknown(cause).message],
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
    controller.abort();
  }
}

function normalizeCriticMode(request: CriticRequest) {
  if (request.mode === undefined) return undefined;
  if (request.operation !== "set-policy") return "mode requires set-policy";
  if (request.enabled !== undefined) return "Choose mode or enabled, not both";
  request.enabled = request.mode === "auto" || request.mode === "both";
  return undefined;
}

function invalidRequest(request: CriticRequest): string | undefined {
  if (
    request.sourceOnly &&
    (request.phase === "understanding" ||
      !["review", "preflight", "prepare"].includes(request.operation))
  )
    return "source-only belongs to product preflight/prepare/dispatch; submission inherits the reserved review scope";
  if (
    request.retryAfter &&
    (!request.reason || !["prepare", "review", "preflight"].includes(request.operation))
  )
    return "retry-after requires prepare, dispatch or preflight and a reason describing the resolved blocker and authorization for a fresh attempt";
  if (request.notInvoked !== undefined && (!request.failure || !request.attempt))
    return "not-invoked requires an attempt and its failure explanation";
  if (request.failureKind && !request.failure) return "failure-kind requires a failure explanation";
  return invalidSubmission(request) ?? invalidOperationOptions(request);
}

function invalidSubmission(request: CriticRequest): string | undefined {
  const raw = request.response !== undefined || request.failure !== undefined;
  const earlyGap = isEarlyCriticGap(request);
  if (
    (request.operation === "submit") !== (!!request.result || raw) ||
    (!!request.result && raw) ||
    (request.failure !== undefined && request.response !== undefined) ||
    (!earlyGap && (request.attempt !== undefined) !== raw) ||
    (raw && request.failure === undefined && !request.capabilities)
  )
    return "submit requires a legacy result OR unchanged response, attempt and actual host capabilities";
  return undefined;
}

function invalidOperationOptions(request: CriticRequest): string | undefined {
  if (
    (request.operation === "configure") !== !!request.config ||
    (request.operation === "set-policy") !== (request.enabled !== undefined) ||
    (request.harness !== undefined && request.operation !== "set-policy") ||
    (request.reason !== undefined &&
      !request.retryAfter &&
      !["set-policy", "reconcile"].includes(request.operation)) ||
    (request.harness !== undefined && request.enabled !== true) ||
    (request.phase !== undefined &&
      !["status", "review", "preflight", "prepare", "submit"].includes(request.operation)) ||
    (request.capabilities !== undefined &&
      !["prepare", "preflight", "submit"].includes(request.operation)) ||
    (request.operation === "restore") !== !!request.candidate ||
    (request.operation === "restore") !== !!request.expectedSubject
  )
    return "configure requires config; policy requires enabled; reconcile accepts a reason; capabilities belong to preflight/prepare/submit; restore requires candidate and expectedSubject";
  return undefined;
}

async function reconcileCritic(
  workspace: WorkspaceState,
  request: CriticRequest,
  selected: import("./critic-store.js").CriticSelection,
) {
  if (!request.reason?.trim())
    return err(
      vispError(
        "ARTIFACT_INVALID",
        "Reconciliation requires a reason; call budgets and prior evidence remain unchanged",
      ),
    );
  const changes = await planCriticRevision(
    workspace,
    selected.record,
    selected.record.brief,
    {
      reason: request.reason,
      provenance: "caller-reported reconciliation of validated brief; not human authentication",
      createdAt: new Date().toISOString(),
    },
    true,
  );
  if (!changes.ok) return changes;
  const saved = await applyFileTransaction(workspace.paths.root, "reconcile-critic-intent", [
    ...recordGuards(workspace, selected.record),
    ...changes.value,
  ]);
  return saved.ok ? criticStatus(workspace, request) : saved;
}
