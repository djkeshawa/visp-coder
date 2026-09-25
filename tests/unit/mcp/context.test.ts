import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { featureScope } from "../../../src/mcp/context.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
});

afterEach(async () => {
  await workspace.destroy();
});

describe("MCP typed workspace context", () => {
  it("rejects explicit feature traversal before the workspace loader runs", async () => {
    const readOnly = await featureScope(workspace.root, "../../outside");

    expect(readOnly.ok).toBe(false);
    expect(!readOnly.ok && readOnly.error.code).toBe("ARTIFACT_INVALID");
  });

  it("returns a typed error when the loader cannot resolve an active feature", async () => {
    const readOnly = await featureScope(workspace.root);

    expect(readOnly.ok).toBe(false);
    expect(!readOnly.ok && readOnly.error.code).toBe("NO_ACTIVE_FEATURE");
  });
});
