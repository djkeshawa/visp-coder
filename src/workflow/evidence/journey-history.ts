import { hashValue } from "../../core/hash.js";
import type { BrowserJourney } from "../../testing/browser-journey.js";
import { productJourneyKey, rawUrlJourneyKey } from "./product-journey.js";

interface RecordedJourney {
  id?: string;
  journey?: BrowserJourney;
  journeyDigest?: string;
  journeyKey?: string;
  task?: string;
  status?: string;
  failure?: { kind: string };
}

/**
 * The current key of a run whose stored journey is intact and whose stored key is the current
 * one or the raw-URL key an earlier build wrote for a loopback journey. Routing identity only.
 */
function currentKeyOf(run: RecordedJourney) {
  if (!run.journey || hashValue(run.journey) !== run.journeyDigest) return undefined;
  const current = productJourneyKey(run.journey, run.task);
  return run.journeyKey === current || run.journeyKey === rawUrlJourneyKey(run.journey, run.task)
    ? current
    : undefined;
}

/** Routing identity only. Never replace a historical receipt's stored key or grant it acceptance. */
export function historicalFailureIdentity(run: RecordedJourney) {
  if (!run.journey || hashValue(run.journey) !== run.journeyDigest) return undefined;
  const current = currentKeyOf(run);
  if (current) return current;
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
  return currentKeyOf(run) !== undefined;
}

/** Same journey, whether its stored key predates loopback normalisation or not. */
export function journeyIdentityKey(run: RecordedJourney) {
  return currentKeyOf(run) ?? run.journeyKey;
}

export function journeyHistoryGroup(run: RecordedJourney, legacyReplays: ReadonlySet<string>) {
  const replayIdentity = exactReplayIdentity(run);
  if (legacyReplays.has(replayIdentity) && (legacyFailure(run) || currentExactReplay(run)))
    return replayIdentity;
  return /^journey-v[23]:/.test(run.journeyKey ?? "")
    ? journeyIdentityKey(run)
    : (run.journeyDigest ?? run.id ?? "legacy");
}
