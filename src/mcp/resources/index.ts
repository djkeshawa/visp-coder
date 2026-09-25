import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "../../core/result.js";
import { RESOURCE, RESOURCE_MIME_TYPE } from "../constants.js";
import { briefPayload, policyPayload, scopePayload, statusPayload } from "./payloads.js";

export function registerResources(server: McpServer, root: string): void {
  server.registerResource(
    "status",
    RESOURCE.status,
    {
      title: "Workflow status",
      description:
        "Current product progress, outcomes, gaps and next action. Use visp_status with detail for full history.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => contents(uri, await statusPayload(root)),
  );

  server.registerResource(
    "policy",
    RESOURCE.policy,
    {
      title: "Active policy",
      description: "Strictness, the rules currently in force, and live overrides.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => contents(uri, await policyPayload(root)),
  );

  server.registerResource(
    "scope",
    RESOURCE.scope,
    {
      title: "Authorized scope",
      description: "Tasks currently authorized to write, with their allowed and forbidden globs.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri) => contents(uri, await scopePayload(root)),
  );

  server.registerResource(
    "feature-brief",
    new ResourceTemplate(RESOURCE.brief, { list: undefined }),
    {
      title: "Working brief",
      description: "The single authored product brief.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async (uri, variables) => contents(uri, await briefPayload(root, single(variables.id))),
  );
}

/**
 * The one place a `Result` becomes an exception. The SDK's resource contract is
 * throw-based, so a refusal has to cross that boundary as an error; every visp
 * module below this line still returns a `Result`.
 */
function contents(uri: URL, result: Result<unknown>): ReadResourceResult {
  if (!result.ok) {
    const { message, recovery } = result.error;
    throw new Error(recovery ? `${message} (try: ${recovery})` : message);
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: RESOURCE_MIME_TYPE,
        text: JSON.stringify(result.value, null, 2),
      },
    ],
  };
}

function single(value: Variables[string] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
