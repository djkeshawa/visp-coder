import type { UiChange } from "../../src/ui/contract.js";
import type { Route } from "./state.js";

export type LiveState = "connecting" | "live" | "paused";

/** The slice of `EventSource` the page uses, so tests can supply a fake. */
export interface EventStream {
  addEventListener(type: string, listener: (event: { data?: string }) => void): void;
  close(): void;
  readonly readyState: number;
}

export interface LiveOptions {
  open(): EventStream;
  onChange(change: UiChange): void;
  onState(state: LiveState): void;
  /** Re-reads what is on screen. Called every 10 s, only while the event stream is down. */
  poll(): void;
  /**
   * Re-reads what is on screen while the stream is open: every 30 s, and once a second after
   * the last change event. The stream sees only `.visp/`; edits to the product's own files
   * make recorded checks stale without any event, and an edit hook's marker is written
   * before the edit lands.
   */
  reread(): void;
  /** False once reconnecting is pointless, such as after the link stopped being accepted. */
  shouldRetry(): boolean;
}

const POLL_MS = 10_000;
const REREAD_MS = 30_000;
const SETTLE_MS = 1_000;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** `EventSource.CLOSED`: the browser has given up on the connection. */
const CLOSED = 2;

/**
 * Follows the server's event stream. Change events name what to re-fetch; the page never
 * trusts them for data. While the stream is not open the page polls every ten seconds and
 * reconnects with a growing delay; the first event from a new connection stops the polling
 * and starts the slower re-read.
 */
export function startLive(options: LiveOptions): () => void {
  let source: EventStream | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let rereader: ReturnType<typeof setInterval> | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let reported: LiveState | undefined;
  let failures = 0;
  let stopped = false;

  // A state is reported when it changes, so failed retries don't repeat it to screen readers.
  const report = (state: LiveState) => {
    if (state === reported) return;
    reported = state;
    options.onState(state);
  };
  const startPolling = () => {
    poller ??= setInterval(options.poll, POLL_MS);
  };
  const stopPolling = () => {
    if (poller !== undefined) clearInterval(poller);
    poller = undefined;
  };
  const stopRereading = () => {
    if (rereader !== undefined) clearInterval(rereader);
    if (settle !== undefined) clearTimeout(settle);
    rereader = undefined;
    settle = undefined;
  };

  const connect = () => {
    reconnect = undefined;
    const stream = options.open();
    source = stream;
    // A retry keeps the state the last failure reported until the stream opens.
    if (reported === undefined) report("connecting");
    startPolling();
    stream.addEventListener("hello", () => {
      failures = 0;
      stopPolling();
      rereader ??= setInterval(options.reread, REREAD_MS);
      report("live");
    });
    stream.addEventListener("change", (event) => {
      try {
        options.onChange(JSON.parse(event.data ?? "") as UiChange);
      } catch {
        // A malformed event is ignored; the next one or the poll catches up.
        return;
      }
      if (settle !== undefined) clearTimeout(settle);
      settle = setTimeout(options.reread, SETTLE_MS);
    });
    stream.addEventListener("error", () => {
      report(stream.readyState === CLOSED ? "paused" : "connecting");
      // Reconnecting here, not in the browser, so the delay can grow.
      stream.close();
      stopRereading();
      startPolling();
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** failures);
      failures += 1;
      reconnect ??= setTimeout(() => {
        if (stopped) return;
        if (options.shouldRetry()) connect();
        else stopPolling();
      }, delay);
    });
  };

  connect();
  return () => {
    stopped = true;
    source?.close();
    if (reconnect !== undefined) clearTimeout(reconnect);
    stopPolling();
    stopRereading();
  };
}

export interface LiveHandlerDeps {
  route(): Route;
  visible(): boolean;
  signedOut(): boolean;
  live(): LiveState;
  setLive(state: LiveState): void;
  loadOverview(): void;
  loadRequests(): void;
  loadFeature(id: string): void;
  refreshVisible(): void;
  schedule(): void;
}

/** What the page does on each live event, apart from the timing in `startLive`. */
export function liveHandlers(
  deps: LiveHandlerDeps,
): Pick<LiveOptions, "onChange" | "onState" | "poll" | "reread" | "shouldRetry"> {
  const rereadFeature = () => {
    const route = deps.route();
    if (deps.visible() && route.view === "feature") deps.loadFeature(route.feature);
  };
  return {
    onChange: (change) => {
      deps.loadOverview();
      deps.loadRequests();
      const route = deps.route();
      if (
        route.view === "feature" &&
        (change.features.includes(route.feature) || change.features.includes("*"))
      )
        deps.loadFeature(route.feature);
    },
    onState: (live) => {
      const recovered = deps.live() !== "live" && live === "live";
      deps.setLive(live);
      if (recovered) deps.refreshVisible();
      deps.schedule();
    },
    poll: rereadFeature,
    reread: rereadFeature,
    shouldRetry: () => !deps.signedOut(),
  };
}
