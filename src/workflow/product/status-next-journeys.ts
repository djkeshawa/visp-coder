import { ok, type Result } from "../../core/result.js";
import {
  recordedReplayRuns,
  replayBatchCommand,
  replayCommand,
} from "../evidence/capture-replay.js";
import { browserFailureRecovery } from "./browser-recovery.js";
import { currentFailedJourneys, currentJourneyFailures } from "./evidence-references.js";
import type { ProductSlice } from "./model.js";
import type { ProductNext } from "./status.js";
import type { ReviewerState } from "./status-next-review.js";
import type { ProductRecord } from "./store.js";

export function environmentJourneyNext(
  record: ProductRecord,
  subject: string,
  journeys: ReturnType<typeof currentFailedJourneys>,
  selectedTask?: string,
): ProductNext | undefined {
  if (!journeys.length || journeys.some((run) => run.failure?.kind === "behavior"))
    return undefined;
  const ordered = selectedTask
    ? [
        ...journeys.filter((run) => run.task === selectedTask),
        ...journeys.filter((run) => run.task !== selectedTask),
      ]
    : journeys;
  const replay = ordered.find(
    (run) => run.id && recordedReplayRuns(record, run.task).some((entry) => entry.id === run.id),
  );
  const run = replay ?? ordered[0];
  const owner = run?.task;
  const task = selectedTask ?? owner;
  const recovery = browserFailureRecovery(
    run?.failure?.message ?? "",
    run?.journey?.url ?? "the configured URL",
    run?.failure?.kind,
  );
  return {
    feature: record.brief.feature,
    ...(task ? { task } : {}),
    action: "understand",
    objective:
      recovery ??
      "Recover the browser execution environment, then rerun the same journey before judging product behavior",
    command: replay?.id
      ? replayCommand(record.brief.feature, replay.id, owner)
      : `visp capture --feature ${record.brief.feature}${owner ? ` --task ${owner}` : ""} --from -`,
    evidence: [
      ...currentJourneyFailures(record, subject, selectedTask),
      ...(replay ? [] : ["No intact saved replay is available; supply the original journey."]),
    ],
    mayEdit: false,
    completion: "unresolved-environment",
    recovery:
      recovery ??
      "Inspect the recorded browser error, restore the host or runtime access it needs, and rerun the journey. An incomplete journey is neither a product failure nor a pass.",
  };
}

export function failedJourneyNext(
  record: ProductRecord,
  subject: string,
  slice: ProductSlice,
  reviewer: ReviewerState,
): Result<ProductNext> | undefined {
  const base = { feature: record.brief.feature, task: slice.id };
  const journeys = currentFailedJourneys(record, subject, slice.id);
  if (journeys.length) {
    const environmentJourney = environmentJourneyNext(record, subject, journeys, slice.id);
    if (environmentJourney) return ok(environmentJourney);
    const replayable = recordedReplayRuns(record, slice.id);
    const pendingReplay = journeys.every((run) => run.subjectDigest !== subject)
      ? journeys.find(
          (run) =>
            run.failure?.kind === "behavior" && replayable.some((entry) => entry.id === run.id),
        )
      : undefined;
    if (pendingReplay?.id)
      return ok({
        ...base,
        action: "fix",
        objective:
          "Replay the recorded input on the current implementation before deciding on further repair or review; the retained failure remains unresolved",
        command: replayBatchCommand(record.brief.feature, pendingReplay.id, slice.id),
        evidence: currentJourneyFailures(record, subject, slice.id),
        mayEdit: true,
        completion: "unresolved-product",
      });
    return ok({
      ...base,
      action: "fix",
      ...(reviewer.runs
        ? {
            objective: `A recorded journey failed on the current code (the evidence gives its message). Fix the product; if your own journey was wrong, rerun a corrected one and keep the promised outcome. Then run visp done${reviewer.capacity.available ? "; VISP starts the reviewer." : "."}`,
            command: `visp work --feature ${record.brief.feature} --task ${slice.id}`,
          }
        : {
            objective:
              "Inspect the failed journey and terminal state. Correct the behavior, or explicitly resolve a mistaken exploratory expectation with current replacement observations; preserve the promised outcome.",
            command: `visp review --handoff --feature ${record.brief.feature} --task ${slice.id}`,
          }),
      evidence: currentJourneyFailures(record, subject, slice.id),
      mayEdit: true,
      completion: "unresolved-product",
    });
  }
}
