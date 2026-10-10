import { afterEach, expect, it, vi } from "vitest";
import { probeBrowserCapability } from "../../../../src/testing/browser-capability.js";
import { BrowserUnavailableError } from "../../../../src/testing/chrome-transport.js";
import {
  checkBrowserEnvironment,
  environmentNext,
  failedBrowserCapability,
} from "../../../../src/workflow/product/environment.js";

vi.mock("../../../../src/testing/browser-capability.js", () => ({
  probeBrowserCapability: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

it("retries transient startup failures instead of reusing the work probe", async () => {
  vi.mocked(probeBrowserCapability)
    .mockRejectedValueOnce(new Error("browser startup timed out"))
    .mockResolvedValueOnce();
  const failed = await checkBrowserEnvironment(process.cwd());
  expect(failed.status).toBe("unavailable");
  const retried = await checkBrowserEnvironment(process.cwd(), failed);
  expect(retried.status).toBe("ready");
  expect(probeBrowserCapability).toHaveBeenCalledTimes(2);
});

it("caches a missing executable, but never calls a missing library a permissions problem", async () => {
  vi.mocked(probeBrowserCapability).mockRejectedValueOnce(
    new BrowserUnavailableError("spawn chrome ENOENT"),
  );
  const failed = await checkBrowserEnvironment(process.cwd());
  expect((await checkBrowserEnvironment(process.cwd(), failed)).kind).toBe("missing-browser");
  expect(probeBrowserCapability).toHaveBeenCalledOnce();
  expect(
    failedBrowserCapability(
      "environment",
      "error while loading shared libraries: libnss3.so: cannot open shared object file",
    ).kind,
  ).toBe("startup");
});

it("routes navigation refusal to restarting the app instead of escalating permissions", () => {
  const next = environmentNext(
    "feature",
    "T001",
    [
      "app-unreachable: Start or restart the app at http://localhost:3000/; net::ERR_CONNECTION_REFUSED",
    ],
    "verify",
  );
  expect(next.recovery).toContain("Start or restart the app at http://localhost:3000/");
  expect(next.command).not.toContain("--retry-environment");
  expect(next.recovery).not.toContain("escalat");
});
