import { describe, expect, it } from "vitest";
import { BUILD_ID, runtimeIdentity, VERSION } from "../../../src/core/version.js";
import { MCP_SERVER_VERSION } from "../../../src/mcp/constants.js";

describe("the MCP server version", () => {
  it("uses the same source of truth as the CLI", () => {
    expect(MCP_SERVER_VERSION).toBe(VERSION);
  });

  it("reports the same build identity through runtime diagnostics", () => {
    expect(runtimeIdentity("/tmp/visp-test-bin")).toEqual({
      version: VERSION,
      buildId: BUILD_ID,
      executable: "/tmp/visp-test-bin",
    });
  });
});
