import type { Route } from "./state.js";
import { state } from "./store.js";

const SEEN_KEY = "visp-ui-seen";

export function readSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSeen(feature: string, at: string): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [feature]: at }));
  } catch {
    // Without storage the marker simply resets each visit.
  }
}

/** Leaving the activity tab marks what was shown as seen. */
export function markActivitySeen(previous: Route, next: Route): void {
  if (previous.view !== "feature" || previous.tab !== "activity") return;
  if (next.view === "feature" && next.feature === previous.feature && next.tab === "activity")
    return;
  const newest = state.features[previous.feature]?.data?.activity[0]?.at;
  if (!newest) return;
  writeSeen(previous.feature, newest);
  state.seenBefore[previous.feature] = newest;
}
