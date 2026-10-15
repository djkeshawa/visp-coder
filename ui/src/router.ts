import { loadForRoute } from "./resources.js";
import { markActivitySeen } from "./seen.js";
import { parseRoute, type Route, routeHash } from "./state.js";
import { pending, schedule, state } from "./store.js";

export function navigate(route: Route): void {
  const hash = routeHash(route);
  if (location.hash !== hash) location.hash = hash;
  else applyRoute();
}

export function applyRoute(): void {
  const previous = state.route;
  const next = parseRoute(location.hash);
  markActivitySeen(previous, next);
  state.route = next;
  if (next.view === "home") redirectHome();
  loadForRoute(state.route);
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    pending.scrollTop = true;
    // Moving between pages puts focus on the new page, as a page load would.
    pending.focusMain = true;
  }
  schedule();
}

function redirectHome(): void {
  const features = state.overview.data?.features;
  const target = state.meta.data?.activeFeature ?? features?.[0]?.id;
  if (target) navigate({ view: "feature", feature: target, tab: "now" });
}
