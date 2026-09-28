import { expect, it } from "vitest";
import { deadlineSignal } from "../../../../src/workflow/product/done-review.js";

it("accepts a fractional deadline, as the CLI computes it from process uptime", () => {
  const signal = deadlineSignal(Date.now() + 99_379.07153320312, undefined);
  expect(signal?.aborted).toBe(false);
});

it("aborts at the deadline and with the caller's signal", async () => {
  expect(deadlineSignal(undefined, undefined)).toBeUndefined();
  const caller = new AbortController();
  const combined = deadlineSignal(Date.now() + 60_000, caller.signal);
  caller.abort();
  expect(combined?.aborted).toBe(true);
  const expiring = deadlineSignal(Date.now() + 5.5, undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(expiring?.aborted).toBe(true);
});
