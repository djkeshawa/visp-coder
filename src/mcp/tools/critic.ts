import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CriticAdapter, runProductCritic } from "../../workflow/product/critic.js";
import { criticRequestSchema } from "../../workflow/product/critic-model.js";
import { rejectedCriticReview } from "../../workflow/product/critic-status.js";
import { mutatingWorkspaceFor, workspaceFor } from "../context.js";
import { mcpCriticHost } from "../critic-host.js";
import { failure } from "../reply.js";
import { productReply } from "./workflow.js";

export function registerCriticTool(
  server: McpServer,
  root: string,
  dispatchServer = server,
  host?: CriticAdapter,
) {
  server.registerTool(
    "visp_critic",
    {
      title: "Bounded product critic",
      description:
        "Independent product feedback. sourceOnly=true requests advisory source findings while rendering is unavailable; it uses the same budget and cannot approve outcomes or resolve prior findings. Preflight inspects capabilities without spending a call. An attached adapter's review invokes once and records the response; standalone hosts receive an explicit native handoff. Prepare returns packet, images, responseSchema and exact submission arguments. Submit unchanged response with attempt and observed capabilities. Optional phase=understanding and question target a design uncertainty; ordinary work does not wait for it. set-policy at the user's request accepts mode auto/manual/both/off (or legacy enabled), preserving history. Manual feedback uses visp_user_feedback during implementation. Recovery uses retryAfter plus reason with preflight/prepare/review after the blocker is resolved and existing authorization permits a fresh call; history and budgets remain. failureKind and notInvoked preserve reported failure provenance. Critic unavailability does not block the baseline build–observe–fix loop; disclose missing independent review. Actual product failures still require correction. Respect permissions, deadlines and cancellation; no automatic retry of pending calls. VISP imposes no text/token ceiling.",
      inputSchema: criticRequestSchema,
    },
    async (args, extra) => {
      const state = await (["status", "preflight"].includes(args.operation ?? "status")
        ? workspaceFor(root)
        : mutatingWorkspaceFor(root));
      if (!state.ok) return failure("visp_critic", state.error);
      const result = await runProductCritic(
        state.value,
        args,
        host ?? (args.operation === "review" ? mcpCriticHost(dispatchServer) : undefined),
        extra?.signal,
      );
      const response = productReply("visp_critic", result);
      if (
        result.ok &&
        (args.operation === "review" ||
          (args.operation === "submit" &&
            (args.response !== undefined || args.result !== undefined))) &&
        rejectedCriticReview(result.value)
      )
        return {
          ...response,
          isError: true,
          structuredContent: { ...response.structuredContent, ok: false },
        };
      return response;
    },
  );
}
