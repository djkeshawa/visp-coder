import type {
  UiExecution,
  UiFeature,
  UiHealth,
  UiMeta,
  UiOverview,
  UiRequests,
} from "../../src/ui/contract.js";
import { type Loaded, load, SignedOutError, signIn, subscribe } from "./api.js";
import { h } from "./dom.js";
import { describeNext } from "./format.js";
import {
  type Actions,
  type AppState,
  executionKey,
  initialState,
  parseRoute,
  type Resource,
  type Route,
  routeHash,
  TABS,
} from "./state.js";
import { applyTheme, currentTheme, saveTheme } from "./theme.js";
import { featurePage } from "./views/feature.js";
import { needsPage } from "./views/needs.js";
import { healthPage, homePage } from "./views/pages.js";
import { TAB_NAMES, topbar } from "./views/topbar.js";

const REFRESH_MS = 10_000;
const SEEN_KEY = "visp-ui-seen";

const state: AppState = initialState();
let knownRequests: Set<string> | undefined;
let lastHeadline: string | undefined;
let renderQueued = false;

const root = document.getElementById("app") as HTMLElement;
const announcer = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });

// ———— Resources ————

async function fetchInto<T>(
  path: string,
  current: Resource<T> | undefined,
  assign: (value: Resource<T>) => void,
): Promise<Loaded<T> | undefined> {
  assign({ ...(current ?? {}), loading: true });
  if (current?.data === undefined) schedule();
  try {
    const result = await load<T>(path);
    if (
      result.ok &&
      current?.data !== undefined &&
      !current.error &&
      sameData(current.data, result.data)
    ) {
      // Nothing changed: skip the re-render so focus, selection and scroll stay put.
      assign({ data: current.data, loading: false, at: Date.now() });
      return result;
    }
    // Keep the last good data when a refresh fails, but say that it failed.
    assign(
      result.ok
        ? { data: result.data, loading: false, at: Date.now() }
        : {
            ...(current?.data !== undefined && result.status === 0 ? { data: current.data } : {}),
            error: result.error,
            loading: false,
          },
    );
    schedule();
    return result;
  } catch (cause) {
    if (cause instanceof SignedOutError) state.signedOut = true;
    assign({ ...(current ?? {}), loading: false });
    schedule();
    return undefined;
  }
}

/** Compares recorded content, ignoring when it was read. */
function sameData(a: unknown, b: unknown): boolean {
  const strip = (key: string, value: unknown) => (key === "readAt" ? undefined : value);
  return JSON.stringify(a, strip) === JSON.stringify(b, strip);
}

const loadMeta = () =>
  fetchInto<UiMeta>("/api/v1/meta", state.meta, (value) => {
    state.meta = value;
  });
const loadOverview = () =>
  fetchInto<UiOverview>("/api/v1/overview", state.overview, (value) => {
    state.overview = value;
  });
const loadHealth = () =>
  fetchInto<UiHealth>("/api/v1/health", state.health, (value) => {
    state.health = value;
  });

async function loadRequests(): Promise<void> {
  const result = await fetchInto<UiRequests>("/api/v1/requests", state.requests, (value) => {
    state.requests = value;
  });
  if (result?.ok) noticeNewRequests(result.data);
}

async function loadFeature(id: string): Promise<void> {
  const result = await fetchInto<UiFeature>(
    `/api/v1/features/${encodeURIComponent(id)}`,
    state.features[id],
    (value) => {
      state.features[id] = value;
    },
  );
  if (result?.ok) announceHeadline(result.data);
}

function loadExecution(feature: string, id: string): void {
  const key = executionKey(feature, id);
  if (state.executions[key]?.data) return; // A recorded run never changes.
  void fetchInto<UiExecution>(
    `/api/v1/features/${encodeURIComponent(feature)}/executions/${encodeURIComponent(id)}`,
    state.executions[key],
    (value) => {
      state.executions[key] = value;
    },
  );
}

function loadForRoute(route: Route): void {
  if (route.view === "feature") {
    void loadFeature(route.feature);
    if (route.run) loadExecution(route.feature, route.run);
  }
  if (route.view === "health") void loadHealth();
  if (route.view === "needs") void loadRequests();
}

function refreshVisible(): void {
  void loadOverview();
  void loadRequests();
  if (state.route.view === "feature") void loadFeature(state.route.feature);
}

// ———— Notifications and announcements ————

function noticeNewRequests(data: UiRequests): void {
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
          navigate({ view: "needs" });
        };
      }
    }
  }
  knownRequests = ids;
  updateTitle();
}

function announceHeadline(feature: UiFeature): void {
  const { headline } = describeNext(feature.next);
  if (lastHeadline !== undefined && lastHeadline !== headline)
    announce(`${feature.goal}: ${headline}`);
  lastHeadline = headline;
}

function announce(text: string): void {
  announcer.textContent = "";
  window.setTimeout(() => {
    announcer.textContent = text;
  }, 50);
}

function updateTitle(): void {
  const count = state.requests.data?.requests.length ?? 0;
  const place = state.meta.data?.repository.name ?? "visp";
  document.title = `${count > 0 ? `(${count}) ` : ""}${place} — visp`;
}

// ———— "New since your last visit" ————

function readSeen(): Record<string, string> {
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
function markActivitySeen(previous: Route, next: Route): void {
  if (previous.view !== "feature" || previous.tab !== "activity") return;
  if (next.view === "feature" && next.feature === previous.feature && next.tab === "activity")
    return;
  const newest = state.features[previous.feature]?.data?.activity[0]?.at;
  if (!newest) return;
  writeSeen(previous.feature, newest);
  state.seenBefore[previous.feature] = newest;
}

// ———— Actions ————

function navigate(route: Route): void {
  const hash = routeHash(route);
  if (location.hash !== hash) location.hash = hash;
  else applyRoute();
}

function applyRoute(): void {
  const previous = state.route;
  const next = parseRoute(location.hash);
  markActivitySeen(previous, next);
  state.route = next;
  if (next.view === "home") redirectHome();
  loadForRoute(state.route);
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    pendingScrollTop = true;
    // Moving between pages puts focus on the new page, as a page load would.
    pendingFocusMain = true;
  }
  schedule();
}

function redirectHome(): void {
  const features = state.overview.data?.features;
  const target = state.meta.data?.activeFeature ?? features?.[0]?.id;
  if (target) navigate({ view: "feature", feature: target, tab: "now" });
}

const actions: Actions = {
  navigate,
  toggle(key) {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    schedule();
  },
  copy(text, button) {
    const label = button.querySelector(".copy-label") ?? button;
    const original = label.textContent;
    const done = (word: string) => {
      label.textContent = word;
      announce(word);
      window.setTimeout(() => {
        label.textContent = original;
      }, 1_600);
    };
    navigator.clipboard?.writeText(text).then(
      () => done("Copied"),
      () => done("Select and copy manually"),
    ) ?? done("Select and copy manually");
  },
  refresh: refreshVisible,
  setDraft(key, value) {
    state.drafts[key] = value;
  },
  enableNotifications() {
    if (typeof Notification === "undefined") return;
    void Notification.requestPermission().then((permission) => {
      state.notifications = permission;
      schedule();
    });
  },
  cycleTheme() {
    const order = { system: "light", light: "dark", dark: "system" } as const;
    saveTheme(order[currentTheme()]);
    schedule();
  },
  toggleWrap() {
    state.wrapOutput = !state.wrapOutput;
    schedule();
  },
  toggleHelp() {
    state.showHelp = !state.showHelp;
    schedule();
  },
  selectFinding(feature, id) {
    state.selectedFinding[feature] = id;
    schedule();
  },
  filterNeeds(filter) {
    state.needsFilter = filter;
    schedule();
  },
  filterRuns(filter) {
    state.runsFilter = filter;
    schedule();
  },
};

// ———— Rendering ————

function schedule(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

let pendingScrollTop = false;
let pendingFocusMain = false;

function render(): void {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset.key;
  const selection = captureSelection();
  const scroll = pendingScrollTop ? 0 : window.scrollY;
  root.replaceChildren(...(state.signedOut ? [signedOutPage()] : appShell()));
  window.scrollTo({ top: scroll });
  pendingScrollTop = false;
  if (pendingFocusMain && !state.signedOut) {
    pendingFocusMain = false;
    document.getElementById("main")?.focus({ preventScroll: true });
  } else restoreFocus(focusKey, selection);
  updateTitle();
}

function appShell(): Node[] {
  return [
    h("a", { class: "skip-link", href: "#main" }, "Skip to content"),
    topbar(state, actions),
    h("main", { id: "main", class: "page", tabindex: -1, "data-key": "main" }, page()),
    footer(),
    ...(state.showHelp ? [helpDialog()] : []),
    announcer,
  ];
}

function page(): Node {
  const route = state.route;
  if (route.view === "feature")
    return featurePage(state, actions, route.feature, route.tab, route.run);
  if (route.view === "needs") return needsPage(state, actions);
  if (route.view === "health") return healthPage(state, actions);
  return homePage(state, actions);
}

function footer(): HTMLElement {
  const meta = state.meta.data;
  const help = h(
    "button",
    { class: "link-button", type: "button", "data-key": "help" },
    "Keyboard shortcuts",
  );
  help.addEventListener("click", () => actions.toggleHelp());
  return h(
    "footer",
    { class: "footer" },
    h(
      "div",
      { class: "footer-inner" },
      meta ? h("span", { class: "mono" }, `VISP ${meta.version}`) : null,
      h(
        "a",
        { href: "#/health", "aria-current": state.route.view === "health" ? "page" : undefined },
        "Installation health",
      ),
      help,
      h("span", null, "Read-only. Commands are shown to copy, never run."),
    ),
  );
}

function signedOutPage(): HTMLElement {
  return h(
    "main",
    { class: "signed-out" },
    h("img", { src: "/symbol.svg", alt: "", width: 40, height: 40 }),
    h("h1", null, "Open the latest link from your terminal"),
    h(
      "p",
      null,
      "This dashboard opens only from the link ",
      h("code", null, "visp ui"),
      " printed, so other pages in your browser can't read it. If the dashboard was restarted, its old link stopped working. Paste the new one here, or run it again:",
    ),
    h("pre", { class: "code-block" }, h("code", null, "visp ui")),
  );
}

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["1 – 5", TABS.map((tab) => TAB_NAMES[tab]).join(", ")],
  ["n", "Needs you"],
  ["r", "Refresh now"],
  ["Esc", "Back from a run, or close this help"],
  ["?", "Show or hide shortcuts"],
];

function helpDialog(): HTMLElement {
  const close = h("button", { class: "button", type: "button", "data-key": "help-close" }, "Close");
  close.addEventListener("click", () => actions.toggleHelp());
  return h(
    "div",
    { class: "help-layer", role: "dialog", "aria-modal": "true", "aria-labelledby": "help-title" },
    h(
      "div",
      { class: "help" },
      h("h2", { id: "help-title" }, "Keyboard shortcuts"),
      h(
        "dl",
        null,
        SHORTCUTS.map(([key, text]) =>
          h("div", null, h("dt", null, h("kbd", null, key)), h("dd", null, text)),
        ),
      ),
      close,
    ),
  );
}

function captureSelection(): { start: number; end: number } | undefined {
  const active = document.activeElement;
  return active instanceof HTMLTextAreaElement
    ? { start: active.selectionStart, end: active.selectionEnd }
    : undefined;
}

function restoreFocus(
  key: string | undefined,
  selection: { start: number; end: number } | undefined,
): void {
  const target = key && document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (selection && target instanceof HTMLTextAreaElement)
    target.setSelectionRange(selection.start, selection.end);
}

// ———— Keyboard ————

function onKey(event: KeyboardEvent): void {
  const typing =
    event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement;
  if (event.key === "Escape") {
    if (state.showHelp) actions.toggleHelp();
    else if (state.route.view === "feature" && state.route.run) {
      const { run: _run, ...rest } = state.route;
      navigate(rest);
    }
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  const index = Number(event.key) - 1;
  if (state.route.view === "feature" && index >= 0 && index < TABS.length) {
    navigate({ view: "feature", feature: state.route.feature, tab: TABS[index] ?? "now" });
  } else if (event.key === "n") navigate({ view: "needs" });
  else if (event.key === "r") refreshVisible();
  else if (event.key === "?") actions.toggleHelp();
}

// ———— Start ————

const TOKEN_HASH = /^#t=([A-Za-z0-9_-]+)$/;

async function start(): Promise<void> {
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  // A fresh link pasted into an open tab only changes the hash; start over with it.
  window.addEventListener("hashchange", () => {
    if (TOKEN_HASH.test(location.hash)) location.reload();
  });
  const token = TOKEN_HASH.exec(location.hash)?.[1];
  if (token) {
    const signedIn = await signIn(token).catch(() => false);
    history.replaceState(null, "", `${location.pathname}#/`);
    if (!signedIn) {
      state.signedOut = true;
      render();
      return;
    }
  }
  const seen = readSeen();
  state.seenBefore = { ...seen };
  state.route = parseRoute(location.hash);
  render();
  await Promise.all([loadMeta(), loadOverview()]);
  if (state.signedOut) return render();
  window.addEventListener("hashchange", applyRoute);
  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshVisible();
  });
  applyRoute();
  void loadRequests();
  subscribe(
    (change) => {
      void loadOverview();
      void loadRequests();
      const route = state.route;
      if (
        route.view === "feature" &&
        (change.features.includes(route.feature) || change.features.includes("*"))
      )
        void loadFeature(route.feature);
    },
    (live) => {
      const recovered = state.live !== "live" && live === "live";
      state.live = live;
      if (recovered) refreshVisible();
      schedule();
    },
  );
  // The product's files change without VISP writing state; re-read what's on screen.
  window.setInterval(() => {
    if (document.visibilityState === "visible" && state.route.view === "feature")
      void loadFeature(state.route.feature);
  }, REFRESH_MS);
}

void start();
