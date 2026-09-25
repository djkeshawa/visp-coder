import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CriticAdapter } from "../workflow/product/critic.js";

/** Standard MCP requires maxTokens. Do not invent a ceiling or silently request a capped review. */
export function mcpCriticHost(server: McpServer): CriticAdapter | undefined {
  if (!server.server.getClientCapabilities()?.sampling) return undefined;
  return {
    unavailable:
      "Standard MCP sampling requires maxTokens and cannot express a review without a token ceiling. Use native preflight/prepare/submit through visp_critic; no critic call was spent.",
  };
}
