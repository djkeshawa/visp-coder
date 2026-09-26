import { sha256 } from "../../../src/core/hash.js";
import { ok, type Result } from "../../../src/core/result.js";
import { now } from "../../../src/workflow/artifacts/common.js";
import type { Intent } from "../../../src/workflow/artifacts/feature.js";
import { captureAcceptanceBaseline } from "../../../src/workflow/evidence/acceptance.js";
import { nextFeatureId } from "../../../src/workflow/product/feature-id.js";
import type { WorkspaceState } from "../../../src/workflow/state.js";
import { legacyStore } from "./legacy-store.js";
import { updateStatus } from "./writers.js";

/** Historical fixture setup, deliberately separate from the active product workflow. */
export async function createLegacyFeature(
  state: WorkspaceState,
  options: { readonly goal: string; readonly workflow?: "compact" | "full" },
): Promise<Result<{ readonly intent: Intent }>> {
  const acceptance = await captureAcceptanceBaseline(state);
  if (!acceptance.ok) return acceptance;
  const features = await state.store.listFeatures();
  if (!features.ok) return features;
  const intent: Intent = {
    kind: "intent",
    createdAt: now(),
    id: nextFeatureId(features.value, options.goal),
    goal: options.goal,
    sourceBrief: options.goal,
    sourceBriefHash: sha256(options.goal),
    riskLevel: "low",
    researchRequired: options.workflow !== "compact",
    workflow: options.workflow ?? "full",
    finalAcceptance: true,
    evidenceContractsRequired: true,
    acceptanceBaseline: acceptance.value,
  };
  const written = await legacyStore(state).writeIntent(intent);
  if (!written.ok) return written;
  const selected = await updateStatus(state, {
    activeFeature: intent.id,
    activeTask: undefined,
    stage: "feature",
    lastCommand: "legacy-fixture",
  });
  return selected.ok ? ok({ intent }) : selected;
}
