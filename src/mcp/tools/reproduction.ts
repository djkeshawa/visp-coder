import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  reproductionRequestSchema,
  runProductReproduction,
} from "../../workflow/product/reproduction.js";
import { TOOL } from "../constants.js";
import { mutatingWorkspaceFor } from "../context.js";
import { failure } from "../reply.js";
import { productReply } from "./workflow.js";

export function registerReproductionTool(server: McpServer, root: string) {
  server.registerTool(
    TOOL.reproduce,
    {
      title: "Attach a failing reproduction",
      description:
        "Link an existing current failed behavioral execution to an unresolved functional finding before editing. Supply the execution ID and explain its relationship to the report. Does not execute a check or resolve the finding. After repair, rerun the same check and relevant adjacent behavior, then obtain separate assessment.",
      inputSchema: reproductionRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) => {
      const state = await mutatingWorkspaceFor(root);
      return state.ok
        ? productReply(TOOL.reproduce, await runProductReproduction(state.value, args))
        : failure(TOOL.reproduce, state.error);
    },
  );
}
