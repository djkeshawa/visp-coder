import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventStream, type LiveState, liveHandlers, startLive } from "../../../ui/src/live.js";
import type { Route } from "../../../ui/src/state.js";

const CLOSED = 2;

class FakeStream implements EventStream {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: string }) => void)[]>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }
  emit(type: string, data?: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

describe("startLive", () => {
  let streams: FakeStream[];
  let polls: number;
  let rereads: number;
  let retry: boolean;
  let states: string[];
  let changes: unknown[];

  const start = () =>
    startLive({
      open: () => {
        const stream = new FakeStream();
        streams.push(stream);
        return stream;
      },
      onChange: (change) => changes.push(change),
      onState: (state) => states.push(state),
      poll: () => {
        polls += 1;
      },
      reread: () => {
        rereads += 1;
      },
      shouldRetry: () => retry,
    });
  const latest = () => streams[streams.length - 1] as FakeStream;

  beforeEach(() => {
    vi.useFakeTimers();
    streams = [];
    polls = 0;
    rereads = 0;
    retry = true;
    states = [];
    changes = [];
  });
  afterEach(() => vi.useRealTimers());

  it("does not poll while the event stream is open", () => {
    start();
    latest().emit("hello");
    vi.advanceTimersByTime(60_000);
    expect(polls).toBe(0);
    expect(states).toEqual(["connecting", "live"]);
  });

  it("passes change events through and ignores malformed ones", () => {
    start();
    latest().emit("hello");
    latest().emit("change", JSON.stringify({ revision: 3, features: ["a"] }));
    latest().emit("change", "{not json");
    expect(changes).toEqual([{ revision: 3, features: ["a"] }]);
  });

  it("polls every ten seconds once the stream errors", () => {
    start();
    latest().emit("hello");
    latest().emit("error");
    expect(states.at(-1)).toBe("connecting");
    vi.advanceTimersByTime(9_999);
    expect(polls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(polls).toBe(1);
    vi.advanceTimersByTime(20_000);
    expect(polls).toBe(3);
  });

  it("reports paused when the browser has given up on the stream", () => {
    start();
    latest().readyState = CLOSED;
    latest().emit("error");
    expect(states.at(-1)).toBe("paused");
  });

  it("reconnects with a growing delay and stops polling once live again", () => {
    start();
    latest().emit("hello");
    latest().emit("error");
    expect(streams).toHaveLength(1);
    expect(latest().closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(streams).toHaveLength(2);
    latest().emit("error");
    vi.advanceTimersByTime(1_999);
    expect(streams).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(3);
    latest().emit("error");
    vi.advanceTimersByTime(4_000);
    expect(streams).toHaveLength(4);
    const before = polls;
    latest().emit("hello");
    expect(states.at(-1)).toBe("live");
    vi.advanceTimersByTime(60_000);
    expect(polls).toBe(before);
  });

  it("caps the reconnect delay and starts again from the shortest after a success", () => {
    start();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      latest().emit("error");
      vi.advanceTimersByTime(30_000);
    }
    expect(streams).toHaveLength(9);
    latest().emit("error");
    vi.advanceTimersByTime(29_999);
    expect(streams).toHaveLength(9);
    vi.advanceTimersByTime(1);
    expect(streams).toHaveLength(10);
    latest().emit("hello");
    latest().emit("error");
    vi.advanceTimersByTime(1_000);
    expect(streams).toHaveLength(11);
  });

  it("polls while the first connection has not opened", () => {
    start();
    vi.advanceTimersByTime(10_000);
    expect(polls).toBe(1);
    latest().emit("hello");
    vi.advanceTimersByTime(30_000);
    expect(polls).toBe(1);
  });

  it("stops everything when stopped", () => {
    const stop = start();
    latest().emit("error");
    stop();
    vi.advanceTimersByTime(120_000);
    expect(polls).toBe(0);
    expect(streams).toHaveLength(1);
    expect(latest().closed).toBe(true);
  });

  it("re-reads every thirty seconds while live, never while down", () => {
    start();
    latest().emit("hello");
    vi.advanceTimersByTime(29_999);
    expect(rereads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rereads).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(rereads).toBe(3);
    latest().emit("error");
    vi.advanceTimersByTime(25_000);
    expect(rereads).toBe(3);
  });

  it("re-reads once, a second after the last change event", () => {
    start();
    latest().emit("hello");
    latest().emit("change", JSON.stringify({ revision: 1, features: ["a"] }));
    vi.advanceTimersByTime(500);
    latest().emit("change", JSON.stringify({ revision: 2, features: ["a"] }));
    vi.advanceTimersByTime(999);
    expect(rereads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(rereads).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(rereads).toBe(1);
  });

  it("stops reconnecting and polling once the page says it is signed out", () => {
    start();
    latest().readyState = CLOSED;
    latest().emit("error");
    retry = false;
    vi.advanceTimersByTime(1_000);
    expect(streams).toHaveLength(1);
    vi.advanceTimersByTime(120_000);
    expect(polls).toBe(0);
    expect(streams).toHaveLength(1);
  });

  it("reports a state once while reconnect attempts keep failing", () => {
    start();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      latest().readyState = CLOSED;
      latest().emit("error");
      vi.advanceTimersByTime(30_000);
    }
    expect(states).toEqual(["connecting", "paused"]);
  });
});

describe("liveHandlers", () => {
  let route: Route;
  let live: LiveState;
  let visible: boolean;
  let signedOut: boolean;
  let calls: string[];

  const handlers = () =>
    liveHandlers({
      route: () => route,
      visible: () => visible,
      signedOut: () => signedOut,
      setLive: (state) => {
        live = state;
      },
      live: () => live,
      loadOverview: () => calls.push("overview"),
      loadRequests: () => calls.push("requests"),
      loadFeature: (id) => calls.push(`feature:${id}`),
      refreshVisible: () => calls.push("refresh"),
      schedule: () => calls.push("schedule"),
    });

  beforeEach(() => {
    route = { view: "feature", feature: "a", tab: "now" };
    live = "connecting";
    visible = true;
    signedOut = false;
    calls = [];
  });

  it("re-reads the open feature only when it is visible on a feature page", () => {
    const { reread, poll } = handlers();
    reread();
    poll();
    expect(calls).toEqual(["feature:a", "feature:a"]);
    visible = false;
    reread();
    route = { view: "needs" };
    visible = true;
    poll();
    expect(calls).toHaveLength(2);
  });

  it("re-fetches the named feature on a change, and anything on a wildcard", () => {
    const { onChange } = handlers();
    onChange({ revision: 1, features: ["b"] });
    expect(calls).toEqual(["overview", "requests"]);
    calls = [];
    onChange({ revision: 2, features: ["a"] });
    onChange({ revision: 3, features: ["*"] });
    expect(calls.filter((call) => call === "feature:a")).toHaveLength(2);
  });

  it("refreshes when the stream becomes live, not on a repeated live", () => {
    const { onState } = handlers();
    onState("live");
    expect(calls).toEqual(["refresh", "schedule"]);
    calls = [];
    onState("live");
    expect(calls).toEqual(["schedule"]);
    onState("connecting");
    calls = [];
    onState("live");
    expect(calls).toEqual(["refresh", "schedule"]);
  });

  it("retries unless signed out", () => {
    const { shouldRetry } = handlers();
    expect(shouldRetry()).toBe(true);
    signedOut = true;
    expect(shouldRetry()).toBe(false);
  });
});
