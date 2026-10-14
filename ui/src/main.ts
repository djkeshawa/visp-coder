import { openEvents, signIn } from "./api.js";
import { onKey } from "./keyboard.js";
import { startLive } from "./live.js";
import { render } from "./render.js";
import { loadFeature, loadMeta, loadOverview, loadRequests, refreshVisible } from "./resources.js";
import { applyRoute } from "./router.js";
import { readSeen } from "./seen.js";
import { parseRoute } from "./state.js";
import { schedule, setRenderer, state } from "./store.js";
import { applyTheme } from "./theme.js";

const TOKEN_HASH = /^#t=([A-Za-z0-9_-]+)$/;

async function start(): Promise<void> {
  setRenderer(render);
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
  // The stream names what changed. Only while it is down does the page poll, because the
  // product's own files can change without VISP writing state.
  startLive({
    open: openEvents,
    onChange: (change) => {
      void loadOverview();
      void loadRequests();
      const route = state.route;
      if (
        route.view === "feature" &&
        (change.features.includes(route.feature) || change.features.includes("*"))
      )
        void loadFeature(route.feature);
    },
    onState: (live) => {
      const recovered = state.live !== "live" && live === "live";
      state.live = live;
      if (recovered) refreshVisible();
      schedule();
    },
    poll: () => {
      if (document.visibilityState === "visible" && state.route.view === "feature")
        void loadFeature(state.route.feature);
    },
  });
}

void start();
