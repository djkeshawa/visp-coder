import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { TOOL } from "../../../src/mcp/constants.js";
import { registerWorkflowTools } from "../../../src/mcp/tools/workflow.js";

it("rejects every pair of mutually exclusive brief inputs before loading a workspace", async () => {
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<CallToolResult>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerWorkflowTools(server, "/nonexistent-brief-boundary");
  const brief = handlers.get(TOOL.brief);
  if (!brief) throw new Error("Brief tool was not registered");
  const inputs = [{ template: true }, { checkTemplate: "command" }, { brief: {} }, { patch: {} }];
  for (let first = 0; first < inputs.length; first++) {
    for (let second = first + 1; second < inputs.length; second++) {
      const result = await brief({ ...inputs[first], ...inputs[second] });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "ARTIFACT_INVALID",
            message: "template, checkTemplate, brief and patch are mutually exclusive",
          },
        },
      });
    }
  }
});
