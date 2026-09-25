import { afterEach, describe, expect, it, vi } from "vitest";
import { probeBrowserCapability } from "../../../src/testing/browser-capability.js";
import * as chrome from "../../../src/testing/chrome-transport.js";
import { pngHeader } from "../support/workspace.js";

afterEach(() => vi.restoreAllMocks());
describe("isolated capability probe", () => {
  it.each(["valid", "missing", "invalid", "session", "capture"] as const)(
    "closes the owned browser after %s result without navigating or publishing evidence",
    async (result) => {
      const send = vi.fn((method: string, params?: Record<string, unknown>) =>
        probeResponse(result, method, params),
      );
      const close = vi.fn(async () => {});
      const launch = vi
        .spyOn(chrome, "launchChrome")
        .mockResolvedValue({ send, close, onEvent: () => () => {} });
      if (result === "valid") await expect(probeBrowserCapability()).resolves.toBeUndefined();
      else await expect(probeBrowserCapability()).rejects.toThrow();
      expect(launch).toHaveBeenCalledWith({ startupTimeoutMs: 4000, operationTimeoutMs: 2000 });
      expect(close).toHaveBeenCalledOnce();
      expect(send.mock.calls.some(([method]) => method === "Page.navigate")).toBe(false);
    },
  );
  it("propagates startup refusal from the adapter that owns startup cleanup", async () => {
    vi.spyOn(chrome, "launchChrome").mockRejectedValue(
      new chrome.BrowserUnavailableError("Refused"),
    );
    await expect(probeBrowserCapability()).rejects.toThrow("Refused");
  });
});

async function probeResponse(result: string, method: string, params?: Record<string, unknown>) {
  if (method === "Target.createTarget") {
    expect(params).toEqual({ url: "about:blank" });
    return { targetId: "blank" };
  }
  if (method === "Target.attachToTarget")
    return result === "session" ? {} : { sessionId: "session" };
  if (method !== "Page.captureScreenshot") return {};
  if (result === "capture") throw new Error("Capture timed out");
  if (result === "missing") return {};
  const bytes = result === "invalid" ? Buffer.from("bad") : pngHeader(320, 240);
  return { data: bytes.toString("base64") };
}
