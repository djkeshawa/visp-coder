import { hashValue } from "../../core/hash.js";
import type { BrowserJourney } from "../../testing/browser-journey.js";
import { productJourneyKey } from "./product-journey.js";

interface RecordedJourney {
  id?: string;
  journey?: BrowserJourney;
  journeyDigest?: string;
  journeyKey?: string;
  task?: string;
  status?: string;
  failure?: { kind: string };
}

/** Routing identity only. Never replace a historical receipt's stored key or grant it acceptance. */
export function historicalFailureIdentity(run: RecordedJourney) {
  if (!run.journey || hashValue(run.journey) !== run.journeyDigest) return undefined;
  const current = productJourneyKey(run.journey, run.task);
  if (run.journeyKey === current) return current;
  return legacyFailure(run) ? exactReplayIdentity(run) : undefined;
}

export function legacyFailure(run: RecordedJourney) {
  return (
    run.failure?.kind === "behavior" &&
    run.status !== "completed" &&
    /^journey-v2:/.test(run.journeyKey ?? "") &&
    !!run.journey &&
    hashValue(run.journey) === run.journeyDigest
  );
}

export function exactReplayIdentity(run: RecordedJourney) {
  return JSON.stringify(["legacy-replay", run.task, run.journeyDigest]);
}

export function currentExactReplay(run: RecordedJourney) {
  return (
    !!run.journey &&
    hashValue(run.journey) === run.journeyDigest &&
    run.journeyKey === productJourneyKey(run.journey, run.task)
  );
}

export function journeyHistoryGroup(run: RecordedJourney, legacyReplays: ReadonlySet<string>) {
  const replayIdentity = exactReplayIdentity(run);
  if (legacyReplays.has(replayIdentity) && (legacyFailure(run) || currentExactReplay(run)))
    return replayIdentity;
  return /^journey-v[23]:/.test(run.journeyKey ?? "")
    ? run.journeyKey
    : (run.journeyDigest ?? run.id ?? "legacy");
}
