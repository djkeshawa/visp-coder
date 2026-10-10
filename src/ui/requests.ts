import { ok, type Result } from "../core/result.js";
import { readProductRecord } from "../workflow/product/store.js";
import type { WorkspaceState } from "../workflow/state.js";
import type { FeatureSummary, UiNext, UiQuestion, UiRequest, UiRequests } from "./contract.js";
import { nextForFeature, overviewView } from "./views.js";

/**
 * Everything waiting on a person, across features. Each entry comes from a
 * recorded question or from what `visp next` reports; nothing is inferred from
 * how long the agent has been quiet.
 */
export async function requestsView(state: WorkspaceState): Promise<Result<UiRequests>> {
  const overview = await overviewView(state);
  if (!overview.ok) return overview;
  const open = overview.value.features.filter((feature) => feature.lifecycle === "active");
  const perFeature = await Promise.all(open.map((feature) => featureRequests(state, feature)));
  return ok({ requests: perFeature.flat() });
}

async function featureRequests(
  state: WorkspaceState,
  feature: FeatureSummary,
): Promise<UiRequest[]> {
  const questions = feature.pendingQuestions > 0 ? await pendingQuestions(state, feature) : [];
  const next = await nextForFeature(state, feature.id);
  const fromNext = next.ok ? nextRequest(feature, next.value) : undefined;
  return [...questions, ...(fromNext ? [fromNext] : [])];
}

async function pendingQuestions(
  state: WorkspaceState,
  feature: FeatureSummary,
): Promise<UiRequest[]> {
  const record = await readProductRecord(state, { feature: feature.id });
  if (!record.ok) return [];
  return (record.value.state.userFeedback ?? [])
    .filter((entry) => entry.status === "pending")
    .map((entry) => {
      const question: UiQuestion = {
        id: entry.id,
        ...(entry.task ? { task: entry.task } : {}),
        question: entry.question,
        ...(entry.context ? { context: entry.context } : {}),
        createdAt: entry.createdAt,
        status: entry.status,
        provenance: entry.provenance,
      };
      return {
        id: `question:${entry.id}`,
        kind: "question" as const,
        feature: feature.id,
        featureGoal: feature.goal,
        title: "Your agent asked a question",
        detail: entry.question,
        createdAt: entry.createdAt,
        command: `${replyCommand(feature.id, entry.id)} '<your answer>'`,
        replyCommand: replyCommand(feature.id, entry.id),
        question,
      };
    });
}

/** The CLI's own spelling, kept next to the server so the page never guesses it. */
export function replyCommand(feature: string, id: string): string {
  return `visp critic feedback --feature ${feature} --id ${id} --reply`;
}

export function nextRequest(feature: FeatureSummary, next: UiNext): UiRequest | undefined {
  const base = { feature: feature.id, featureGoal: feature.goal };
  if (next.completion === "handoff")
    return {
      ...base,
      id: `handoff:${feature.id}`,
      kind: "handoff",
      title: "Review budget spent with findings still open",
      detail:
        "The independent reviewer's findings were not all resolved. Read the handoff and decide what happens next.",
      command: `visp pr --feature ${feature.id}`,
    };
  if (next.completion === "unresolved-environment")
    return {
      ...base,
      id: `environment:${feature.id}`,
      kind: "environment",
      title: "A check could not run in this environment",
      detail: next.recovery ?? next.objective,
      ...(next.command ? { command: next.command } : {}),
    };
  if (next.action === "accept")
    return {
      ...base,
      id: `acceptance:${feature.id}`,
      kind: "acceptance",
      title: "Ready for acceptance",
      detail:
        "Every slice is closed. Look over the outcomes and the handoff before the agent accepts the feature.",
      command: next.command ?? `visp accept --feature ${feature.id}`,
    };
  return undefined;
}
