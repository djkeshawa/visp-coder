import type { UiFeature, UiRequests } from "../../src/ui/contract.js";
import { announce } from "./announce.js";
import { describeNext } from "./format.js";
import { routeHash } from "./state.js";
import { state } from "./store.js";

let knownRequests: Set<string> | undefined;
let lastHeadline: string | undefined;

/** Announces requests that appeared since the last read, and notifies when the tab is hidden. */
export function noticeNewRequests(data: UiRequests): void {
  const ids = new Set(data.requests.map((request) => request.id));
  if (knownRequests) {
    const fresh = data.requests.filter((request) => !knownRequests?.has(request.id));
    for (const request of fresh) {
      announce(`Needs you: ${request.title}`);
      if (state.notifications === "granted" && document.visibilityState !== "visible") {
        const notification = new Notification(request.title, {
          body: `${request.featureGoal}\n${request.detail}`,
          tag: request.id,
        });
        notification.onclick = () => {
          window.focus();
          location.hash = routeHash({ view: "needs" });
        };
      }
    }
  }
  knownRequests = ids;
  updateTitle();
}

export function announceHeadline(feature: UiFeature): void {
  const { headline } = describeNext(feature.next);
  if (lastHeadline !== undefined && lastHeadline !== headline)
    announce(`${feature.goal}: ${headline}`);
  lastHeadline = headline;
}

export function updateTitle(): void {
  const count = state.requests.data?.requests.length ?? 0;
  const place = state.meta.data?.repository.name ?? "visp";
  document.title = `${count > 0 ? `(${count}) ` : ""}${place} — visp`;
}
