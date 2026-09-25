import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { Result } from "../../../src/core/result.js";
import { TOOL } from "../../../src/mcp/constants.js";
import { registerWorkflowTools } from "../../../src/mcp/tools/workflow.js";

const calls = vi.hoisted(() => {
  const response = (route: string) =>
    vi.fn(async (): Promise<Result<{ route: string }>> => ({ ok: true, value: { route } }));
  return {
    workspaceFor: vi.fn(async () => ({ ok: true, value: { mode: "read" } })),
    mutatingWorkspaceFor: vi.fn(async () => ({ ok: true, value: { mode: "write" } })),
    readProductBrief: response("read"),
    updateProductBrief: response("update"),
    productInputTemplate: response("template"),
    productCheckTemplate: response("check-template"),
  };
});

vi.mock("../../../src/mcp/context.js", () => ({
  workspaceFor: calls.workspaceFor,
  mutatingWorkspaceFor: calls.mutatingWorkspaceFor,
}));
vi.mock("../../../src/workflow/product/index.js", () => ({
  createProductFeature: vi.fn(),
  readProductBrief: calls.readProductBrief,
  runProductContext: vi.fn(),
  runProductMigrate: vi.fn(),
  runProductNext: vi.fn(),
  runProductStatus: vi.fn(),
  runProductWork: vi.fn(),
  updateProductBrief: calls.updateProductBrief,
}));
vi.mock("../../../src/workflow/product/check-guidance.js", () => ({
  productCheckTemplate: calls.productCheckTemplate,
}));
vi.mock("../../../src/workflow/product-inputs.js", () => ({
  PRODUCT_BRIEF_ENTRY_GUIDE: "Brief authoring guidance",
  productInputTemplate: calls.productInputTemplate,
}));

beforeEach(() => vi.clearAllMocks());

it("routes each brief mode through the correct workspace and service", async () => {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  registerWorkflowTools(
    {
      registerTool(
        name: string,
        _config: unknown,
        handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    "/unused-brief-root",
  );
  const brief = handlers.get(TOOL.brief);
  if (!brief) throw new Error("Brief tool was not registered");

  for (const [args, route, workspace] of [
    [{}, "read", "read"],
    [{ checkTemplate: "command" }, "check-template", "read"],
    [{ template: true }, "template", "read"],
    [{ brief: {} }, "update", "write"],
    [{ patch: {} }, "update", "write"],
  ] as const) {
    const response = await brief(args);
    expect(response.structuredContent).toMatchObject({ ok: true, data: { route } });
    expect(calls.workspaceFor).toHaveBeenCalledTimes(workspace === "read" ? 1 : 0);
    expect(calls.mutatingWorkspaceFor).toHaveBeenCalledTimes(workspace === "write" ? 1 : 0);
    const guidance = (response.structuredContent as { guidance?: string }).guidance;
    expect(guidance).toBe(route === "template" ? "Brief authoring guidance" : undefined);
    expect((response.structuredContent as { data: unknown }).data).not.toHaveProperty("guidance");
    vi.clearAllMocks();
  }

  calls.productInputTemplate.mockResolvedValueOnce({
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: "No current brief" },
  });
  const failedTemplate = await brief({ template: true });
  expect(failedTemplate.isError).toBe(true);
  expect(failedTemplate.structuredContent).not.toHaveProperty("guidance");
});
