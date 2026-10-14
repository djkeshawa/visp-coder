import type { UiChange } from "../../src/ui/contract.js";

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
  /** Re-reads what is on screen. Called only while the event stream is down. */
  poll(): void;
}

const POLL_MS = 10_000;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** `EventSource.CLOSED`: the browser has given up on the connection. */
const CLOSED = 2;

/**
 * Follows the server's event stream. Change events name what to re-fetch; the page never
 * trusts them for data. While the stream is not open the page polls every ten seconds and
 * reconnects with a growing delay; the first event from a new connection stops the polling.
 */
export function startLive(options: LiveOptions): () => void {
  let source: EventStream | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let failures = 0;
  let stopped = false;

  const startPolling = () => {
    poller ??= setInterval(options.poll, POLL_MS);
  };
  const stopPolling = () => {
    if (poller !== undefined) clearInterval(poller);
    poller = undefined;
  };

  const connect = () => {
    reconnect = undefined;
    const stream = options.open();
    source = stream;
    options.onState("connecting");
    startPolling();
    stream.addEventListener("hello", () => {
      failures = 0;
      stopPolling();
      options.onState("live");
    });
    stream.addEventListener("change", (event) => {
      try {
        options.onChange(JSON.parse(event.data ?? "") as UiChange);
      } catch {
        // A malformed event is ignored; the next one or the poll catches up.
      }
    });
    stream.addEventListener("error", () => {
      options.onState(stream.readyState === CLOSED ? "paused" : "connecting");
      // Reconnecting here, not in the browser, so the delay can grow.
      stream.close();
      startPolling();
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** failures);
      failures += 1;
      reconnect ??= setTimeout(() => {
        if (!stopped) connect();
      }, delay);
    });
  };

  connect();
  return () => {
    stopped = true;
    source?.close();
    if (reconnect !== undefined) clearTimeout(reconnect);
    stopPolling();
  };
}
