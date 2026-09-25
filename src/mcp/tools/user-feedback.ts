import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  runProductUserFeedback,
  type UserFeedbackHost,
} from "../../workflow/product/user-feedback.js";
import { userFeedbackRequestSchema } from "../../workflow/product/user-feedback-model.js";
import { mutatingWorkspaceFor, workspaceFor } from "../context.js";
import { failure } from "../reply.js";
import { productReply } from "./workflow.js";

/** Standard MCP form elicitation is user input, not sampling or a paid critic call. */
export function mcpUserFeedbackHost(server: McpServer): UserFeedbackHost | undefined {
  const elicitation = server.server.getClientCapabilities()?.elicitation;
  if (!elicitation || !("form" in elicitation)) return undefined;
  return {
    async ask(prompt, options) {
      const result = await server.server.elicitInput(
        {
          mode: "form",
          message: `Original request: ${prompt.originalRequest}\nCurrent slice: ${prompt.objective}${prompt.context ? `\n${prompt.context}` : ""}\n\n${prompt.question}`,
          requestedSchema: {
            type: "object",
            properties: {
              feedback: {
                type: "string",
                title: "Your feedback",
                description: "What works, what feels wrong, or what should change?",
              },
            },
            required: ["feedback"],
          },
        },
        { signal: options.signal },
      );
      if (result.action !== "accept") return { action: "defer" };
      const text = result.content?.feedback;
      if (typeof text !== "string" || !text.trim())
        throw new Error("The host returned no user feedback; request remains pending");
      return { action: "answer", text };
    },
  };
}

export function registerUserFeedbackTool(
  server: McpServer,
  root: string,
  dispatchServer = server,
  host?: UserFeedbackHost,
) {
  server.registerTool(
    "visp_user_feedback",
    {
      title: "User feedback during implementation",
      description:
        "Manual critic: ask one focused question at a usable slice or consequential design uncertainty. Uses MCP user elicitation when supported; otherwise returns a native question-tool handoff. Do not answer for the user. Status is read-only; reply records the user's words, defer is not approval. Feedback is advisory and does not consume model review calls, weaken outcomes, or block unrelated work. Configure critic mode manual or both first.",
      inputSchema: userFeedbackRequestSchema,
    },
    async (args, extra) => {
      const state = await (args.operation === "status"
        ? workspaceFor(root)
        : mutatingWorkspaceFor(root));
      return state.ok
        ? productReply(
            "visp_user_feedback",
            await runProductUserFeedback(
              state.value,
              args,
              host ?? (args.operation === "ask" ? mcpUserFeedbackHost(dispatchServer) : undefined),
              extra?.signal,
            ),
          )
        : failure("visp_user_feedback", state.error);
    },
  );
}
