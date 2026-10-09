import type {
  UiError,
  UiExecution,
  UiFeature,
  UiHealth,
  UiMeta,
  UiOverview,
  UiRequests,
} from "../../src/ui/contract.js";
import type { LiveState } from "./api.js";

export interface Resource<T> {
  readonly data?: T;
  readonly error?: UiError;
  readonly loading: boolean;
  /** When the data was last read, in page time. */
  readonly at?: number;
}

export const idle = <T>(): Resource<T> => ({ loading: false });

export type Tab = "progress" | "review" | "activity" | "handoff";
export const TABS: readonly Tab[] = ["progress", "review", "activity", "handoff"];

export type Route =
  | { readonly view: "home" }
  | { readonly view: "feature"; readonly feature: string; readonly tab: Tab; readonly run?: string }
  | { readonly view: "needs" }
  | { readonly view: "health" };

export interface AppState {
  meta: Resource<UiMeta>;
  overview: Resource<UiOverview>;
  requests: Resource<UiRequests>;
  health: Resource<UiHealth>;
  features: Record<string, Resource<UiFeature>>;
  executions: Record<string, Resource<UiExecution>>;
  route: Route;
  live: LiveState;
  signedOut: boolean;
  /** Disclosure state that must survive a live re-render. */
  expanded: Set<string>;
  /** Reply drafts, kept in state so a live update never erases typing. */
  drafts: Record<string, string>;
  /** When each feature's activity was last opened, for the "new since" marker. */
  seenBefore: Record<string, string>;
  wrapOutput: boolean;
  notifications: NotificationPermission | "unsupported";
  showHelp: boolean;
}

export function initialState(): AppState {
  return {
    meta: idle(),
    overview: idle(),
    requests: idle(),
    health: idle(),
    features: {},
    executions: {},
    route: { view: "home" },
    live: "connecting",
    signedOut: false,
    expanded: new Set(),
    drafts: {},
    seenBefore: {},
    wrapOutput: true,
    notifications: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
    showHelp: false,
  };
}

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "needs") return { view: "needs" };
  if (parts[0] === "health") return { view: "health" };
  if (parts[0] === "f" && parts[1]) {
    const tab = (TABS as readonly string[]).includes(parts[2] ?? "")
      ? (parts[2] as Tab)
      : "progress";
    const run = new URLSearchParams(query).get("run") ?? undefined;
    return { view: "feature", feature: parts[1], tab, ...(run ? { run } : {}) };
  }
  return { view: "home" };
}

export function routeHash(route: Route): string {
  if (route.view === "needs") return "#/needs";
  if (route.view === "health") return "#/health";
  if (route.view === "home") return "#/";
  const base = `#/f/${encodeURIComponent(route.feature)}/${route.tab}`;
  return route.run ? `${base}?run=${encodeURIComponent(route.run)}` : base;
}

export interface Actions {
  navigate(route: Route): void;
  toggle(key: string): void;
  copy(text: string, button: HTMLElement): void;
  refresh(): void;
  setDraft(key: string, value: string): void;
  enableNotifications(): void;
  cycleTheme(): void;
  toggleWrap(): void;
  toggleHelp(): void;
}

export const executionKey = (feature: string, id: string) => `${feature}/${id}`;
