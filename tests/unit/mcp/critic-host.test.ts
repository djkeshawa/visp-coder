import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { mcpCriticHost } from "../../../src/mcp/critic-host.js";

it("reports absent sampling rather than selecting another provider", () => {
  expect(
    mcpCriticHost({ server: { getClientCapabilities: () => ({}) } } as unknown as McpServer),
  ).toBeUndefined();
});

it("counterchecks the protocol constraint and reports an uncapped sampling gap without dispatch", () => {
  const request = {
    method: "sampling/createMessage",
    params: { messages: [{ role: "user", content: { type: "text", text: "review" } }] },
  };
  expect(CreateMessageRequestSchema.safeParse(request).success).toBe(false);
  expect(
    CreateMessageRequestSchema.safeParse({
      ...request,
      params: { ...request.params, maxTokens: 4096 },
    }).success,
  ).toBe(true);
  const createMessage = vi.fn();
  const host = mcpCriticHost({
    server: { getClientCapabilities: () => ({ sampling: {} }), createMessage },
  } as unknown as McpServer);
  expect(host).toEqual({ unavailable: expect.stringContaining("requires maxTokens") });
  expect(createMessage).not.toHaveBeenCalled();
});
