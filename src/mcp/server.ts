import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/load.js";
import { DEFAULT_PROFILE, type Profile } from "../core/constants.js";
import { fromUnknown } from "../core/errors.js";
import { ProjectPaths } from "../core/paths.js";
import { err, ok, type Result } from "../core/result.js";
import type { CriticAdapter } from "../workflow/product/critic.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./constants.js";
import { registerResources } from "./resources/index.js";
import { registerTools } from "./tools/index.js";

/**
 * The same capabilities the CLI exposes, offered as MCP tools so an agent can
 * call them instead of shelling out. Every tool wraps the command's function;
 * none of them reimplements it.
 */
// Direct library consumers historically received the complete server. The CLI
// always passes the project's configured profile through serveStdio.
export function createServer(
  root: string,
  profile: Profile = "standard",
  criticHost?: CriticAdapter,
  userFeedbackHost?: import("../workflow/product/user-feedback.js").UserFeedbackHost,
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Before writing any file, call visp_guard with the paths you intend to touch. " +
        "Use visp_work to receive relevant context and authorize scope together. For browser UI, prefer visp_capture over shell capture commands or generic browser screenshots so the journey and images remain bound to VISP review evidence. Call visp_next for the next product action. If manual feedback is enabled, use visp_user_feedback at a usable slice or consequential design question; continue unrelated work while awaiting the user. Review actual UI images when scheduled; unresolved goals must remain visible.",
    },
  );

  registerTools(server, root, profile, criticHost, userFeedbackHost);
  // Resources are a browsing surface; the minimal profile's point is fewer
  // resident definitions, and every payload stays reachable through tools.
  if (profile !== "minimal") registerResources(server, root);

  return server;
}

/**
 * stdout carries the MCP protocol and nothing else, so diagnostics go to stderr.
 * A stray `console.log` here corrupts the stream.
 */
export async function serveStdio(root: string): Promise<Result<void>> {
  const config = await loadConfig(new ProjectPaths(root));
  const server = createServer(root, config.ok ? config.value.profile : DEFAULT_PROFILE);

  try {
    await server.connect(new StdioServerTransport());
    process.stderr.write(`${MCP_SERVER_NAME} MCP server ready on stdio (project: ${root})\n`);
    return ok(undefined);
  } catch (cause) {
    return err(fromUnknown(cause, "INTERNAL"));
  }
}
