import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeCriticOnce } from "../../../../src/workflow/product/critic-invocation.js";
import type { CriticConfig } from "../../../../src/workflow/product/critic-model.js";
import type { CriticPacket } from "../../../../src/workflow/product/critic-packet.js";

const packet = {} as CriticPacket;
const config = {} as CriticConfig;
afterEach(() => vi.useRealTimers());
describe("one bounded adapter call", () => {
  it("distinguishes timeout from caller cancellation without retrying", async () => {
    for (const reason of ["timeout", "cancel"] as const) {
      vi.useFakeTimers();
      vi.setSystemTime(10000);
      const caller = new AbortController();
      let received: AbortSignal | undefined;
      const host = {
        review: vi.fn(async (_packet, options) => {
          received = options.signal;
          return new Promise<never>(() => {});
        }),
      };
      const pending = invokeCriticOnce(host, packet, config, 11000, caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (reason === "cancel") caller.abort();
      else await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;
      expect(result.adapterCall).toEqual({
        startedAt: 10000,
        finishedAt: reason === "cancel" ? 10000 : 11000,
        outcome: reason === "cancel" ? "cancelled" : "timed-out",
      });
      expect(result.failure).toContain(
        reason === "cancel" ? "cancelled by caller" : "deadline exceeded",
      );
      expect(result.returnedAt).toBeUndefined();
      expect(received?.aborted).toBe(true);
      expect(host.review).toHaveBeenCalledOnce();
      vi.useRealTimers();
    }
  });
  it("records a response before validation, and a thrown adapter failure without inventing provider invocation", async () => {
    const response = { model: "test", response: { observations: [] } };
    for (const fails of [false, true]) {
      const host = {
        review: vi.fn(async () => {
          if (fails) throw new Error("host disconnected");
          return response;
        }),
      };
      const result = await invokeCriticOnce(host, packet, config, Date.now() + 1000);
      expect(result.adapterCall.outcome).toBe(fails ? "failed" : "returned");
      expect(result.adapterCall.startedAt).toEqual(expect.any(Number));
      expect(result.adapterCall).not.toHaveProperty("invoked");
      expect(result.response).toEqual(fails ? undefined : response);
      expect(host.review).toHaveBeenCalledOnce();
    }
  });
  it("does not call an adapter after prior cancellation or expiry", async () => {
    const caller = new AbortController();
    caller.abort();
    for (const signal of [undefined, caller.signal]) {
      const host = { review: vi.fn() };
      const result = await invokeCriticOnce(host, packet, config, Date.now() - 1, signal);
      expect(host.review).not.toHaveBeenCalled();
      expect(result.adapterCall.startedAt).toBeUndefined();
      expect(result.adapterCall.outcome).toBe(signal ? "cancelled" : "timed-out");
    }
  });
  it("discards late adapter results without changing the completed outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10000);
    const host = {
      review: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { model: "test", response: {} };
      }),
    };
    const pending = invokeCriticOnce(host, packet, config, 11000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    await vi.advanceTimersByTimeAsync(2000);
    expect(result.adapterCall.outcome).toBe("timed-out");
    expect(result.response).toBeUndefined();
    expect(host.review).toHaveBeenCalledOnce();
  });
  it("propagates cancellation between reservation and the queued adapter call", async () => {
    const caller = new AbortController();
    const host = { review: vi.fn() };
    const pending = invokeCriticOnce(host, packet, config, Date.now() + 1000, caller.signal);
    caller.abort();
    const result = await pending;
    expect(host.review).not.toHaveBeenCalled();
    expect(result.adapterCall.startedAt).toBeUndefined();
    expect(result.adapterCall.outcome).toBe("cancelled");
  });
});
