import { join } from "node:path";
import { criticMode } from "../../config/critic.js";
import { resolveCriticPolicy } from "../../config/critic-defaults.js";
import { vispError } from "../../core/errors.js";
import { applyFileTransaction, filePrecondition } from "../../core/file-transaction.js";
import { hashValue } from "../../core/hash.js";
import { err, ok, type Result } from "../../core/result.js";
import type { WorkspaceState } from "../state.js";
import { type CriticConfig, type CriticRequest, criticStateSchema } from "./critic-model.js";
import { criticSelection } from "./critic-store.js";
import type { ProductState } from "./model.js";
import { briefPath, json, productStatePath } from "./store.js";

export const CRITIC_SETUP_GAP =
  "Critic is on but its reviewer host is unconfigured. Setup is incomplete: choose codex, claude-code, cursor or copilot with visp critic --on --harness <host>, then run --preflight. Generic installation is not reviewer availability.";
export const PENDING_REVIEW_MESSAGE =
  "A critic review is pending; wait for its result or deadline before editing";

export function missingCriticSetup(state: ProductState) {
  return state.status === "active" && state.criticEnabled === true && !state.criticDefault;
}

/** Called under the shared mutation lock. Policy is bookkeeping, never product evidence. */
export async function setFeatureCriticPolicy(workspace: WorkspaceState, request: CriticRequest) {
  const selected = await criticSelection(workspace, request);
  if (!selected.ok) return selected;
  if (request.task !== undefined)
    return err(
      vispError("ARTIFACT_INVALID", "--on/--off sets the whole feature policy; omit task"),
    );
  const { record } = selected.value;
  if (record.state.status === "historical-complete")
    return err(
      vispError(
        "STAGE_BLOCKED",
        "Historical features stay historical; create a new feature for critic evaluation",
      ),
    );
  const pending = await hasPendingCriticReview(workspace, record.brief.feature);
  if (!pending.ok) return pending;
  if (
    pending.value &&
    (request.mode === undefined || record.state.criticEnabled !== request.enabled)
  )
    return err(
      vispError(
        "STATE_BUSY",
        "A critic review is pending; wait for its result or deadline before switching policy",
      ),
    );
  const enabled = request.enabled === true;
  const manual = request.mode === "manual" || request.mode === "both";
  const resolved = await policyConfig(workspace, request, record.state.criticDefault);
  if (!resolved.ok) return resolved;
  const config = resolved.value;
  if (
    record.state.criticEnabled === enabled &&
    !!record.state.criticManual === manual &&
    config === record.state.criticDefault
  )
    return ok({
      enabled,
      manual,
      mode: criticMode(enabled, manual),
      appliesTo: "whole feature",
      unchanged: true,
    });
  const state = updatedPolicy(record.state, request, config);
  const saved = await applyFileTransaction(workspace.paths.root, "critic-policy", [
    {
      kind: "write",
      path: briefPath(workspace, record.brief.feature),
      content: record.briefText,
      expectedBefore: filePrecondition(record.briefText),
    },
    {
      kind: "write",
      path: productStatePath(workspace, record.brief.feature),
      content: json(state),
      expectedBefore: filePrecondition(record.stateText),
    },
  ]);
  return saved.ok
    ? ok({
        enabled,
        manual,
        mode: criticMode(enabled, manual),
        appliesTo: "whole feature",
        config,
        history: "preserved",
        gaps: enabled && !config ? [CRITIC_SETUP_GAP] : [],
        note: "Budgets and individual selection settings are preserved. This records a caller request, not proof of human authorization. Normal product checks and findings still apply.",
      })
    : saved;
}

async function policyConfig(
  workspace: WorkspaceState,
  request: CriticRequest,
  config: CriticConfig | undefined,
) {
  const enabled = request.enabled === true;
  if (enabled && request.harness && config?.harness && request.harness !== config.harness)
    return err(
      vispError(
        "CONFIG_INVALID",
        "The reviewer host is already pinned; switching on cannot replace it or reset budgets",
      ),
    );
  if (enabled && !config) {
    const resolved = await resolveCriticPolicy(workspace.config.harness, {
      ...workspace.config.critic,
      enabled: true,
      mode: "auto",
      ...(request.harness ? { harness: request.harness } : {}),
    });
    if (!resolved.ok) return resolved;
    return ok(resolved.value.config);
  }
  return ok(config);
}

function updatedPolicy(
  previous: ProductState,
  request: CriticRequest,
  config: CriticConfig | undefined,
) {
  const enabled = request.enabled === true;
  const timestamp = new Date().toISOString();
  const state: ProductState = {
    ...previous,
    updatedAt: timestamp,
    criticEnabled: enabled,
    criticManual: request.mode === "manual" || request.mode === "both",
    ...(config ? { criticDefault: config } : {}),
    criticPolicyChanges: [
      ...(previous.criticPolicyChanges ?? []),
      {
        enabled,
        ...(request.mode ? { manual: request.mode === "manual" || request.mode === "both" } : {}),
        createdAt: timestamp,
        provenance: "caller-reported",
        reason: request.reason ?? `Explicit feature critic ${enabled ? "on" : "off"} operation`,
      },
    ],
  };
  return state;
}

/**
 * A pending reviewer owns the current implementation window until it returns
 * a result or reaches its deadline. Callers use this before granting any
 * mutation authority; reads and inspection remain available.
 */
export async function hasPendingCriticReview(workspace: WorkspaceState, feature: string) {
  const directory = join(workspace.paths.featureDir(feature), "critic");
  const entries = await workspace.files.listEntries(directory);
  if (!entries.ok) return entries;
  for (const entry of entries.value) {
    if (!entry.name.endsWith(".json")) continue;
    const loaded = await workspace.files.readJson(join(directory, entry.name), (input) => {
      const parsed = criticStateSchema.safeParse(input);
      return parsed.success &&
        parsed.data.root === hashValue(workspace.paths.root) &&
        parsed.data.feature === feature
        ? ok(parsed.data)
        : err(vispError("ARTIFACT_INVALID", "Invalid critic state; policy unchanged"));
    });
    if (!loaded.ok) return loaded;
    if (
      loaded.value.attempts.some(
        (attempt) =>
          attempt.status === "pending" &&
          Date.now() <= attempt.startedAt + loaded.value.config.timeoutMs,
      )
    )
      return ok(true);
  }
  return ok(false);
}

export async function requireNoPendingCriticReview(
  workspace: WorkspaceState,
  feature: string,
  recovery: string,
): Promise<Result<void>> {
  const pending = await hasPendingCriticReview(workspace, feature);
  if (!pending.ok) return pending;
  return pending.value
    ? err(vispError("STATE_BUSY", PENDING_REVIEW_MESSAGE, { recovery }))
    : ok(undefined);
}
