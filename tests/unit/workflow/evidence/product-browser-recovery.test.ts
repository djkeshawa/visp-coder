import { describe, expect, it } from "vitest";
import {
  browserFailureRecovery,
  executionRecovery,
} from "../../../../src/workflow/product/browser-recovery.js";

describe("browserFailureRecovery", () => {
  it("gives a behavior failure no environment or check-authoring advice", () => {
    // An app exception can say it timed out; that is the product failing.
    expect(browserFailureRecovery("fetch timed out", "http://x/", "behavior")).toBeUndefined();
    expect(browserFailureRecovery("browser disconnected", "http://x/", "behavior")).toBeUndefined();
    expect(
      browserFailureRecovery("net::ERR_CONNECTION_REFUSED", "http://x/", "behavior"),
    ).toBeUndefined();
  });

  it("keeps the timeout advice for an environment failure and for an unknown kind", () => {
    expect(browserFailureRecovery("click timed out", "http://x/", "environment")).toMatch(
      /^check-authoring:/,
    );
    expect(browserFailureRecovery("click timed out", "http://x/")).toMatch(/^check-authoring:/);
  });

  it("keeps the unreachable-app advice", () => {
    expect(browserFailureRecovery("net::ERR_CONNECTION_REFUSED", "http://x/", "environment")).toBe(
      "app-unreachable: Start or restart the app at http://x/, confirm it responds, then rerun the same journey.",
    );
  });

  it("names a disconnected browser before the generic timeout advice", () => {
    const text = browserFailureRecovery("browser disconnected", "http://x/", "environment");
    expect(text).toMatch(/^browser-disconnected: The browser closed while the journey ran\./);
    expect(text).toContain("Rerun the same journey once.");
    expect(text).toContain("that is a product failure to fix");
    expect(browserFailureRecovery("browser disconnected after timed out", "http://x/")).toMatch(
      /^browser-disconnected:/,
    );
  });
});

describe("executionRecovery", () => {
  it("returns the disconnected line from recorded evidence", () => {
    const line = browserFailureRecovery("browser disconnected", "http://x/", "environment");
    expect(executionRecovery([`Journey failed\n${line}\nmore`])).toBe(line);
  });

  it("still prefers an unreachable app and falls back to the stalled-check advice", () => {
    expect(executionRecovery(["app-unreachable: Start it"])).toBe("app-unreachable: Start it");
    expect(executionRecovery(["check-authoring: fix waits"])).toMatch(/^Inspect the stalled check/);
    expect(executionRecovery(["nothing"])).toBeUndefined();
  });
});
