import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browserJourneySchema } from "../../testing/browser-journey.js";
import { runProductCapture } from "../../workflow/evidence/product-capture.js";
import { mutatingWorkspaceFor } from "../context.js";
import { failure } from "../reply.js";
import { productReply, productSelectionInput } from "./workflow.js";

export function registerCaptureTools(server: McpServer, root: string): void {
  server.registerTool(
    "visp_capture",
    {
      title: "Capture an actual browser journey",
      description:
        "Execute one continuous browser journey and return verified images. Each call starts fresh: put act, settle, act again and applicable pending reset in one actions array. Supply journey, or replay:<runId> to rerun stored actions unchanged after a repair. Resize changes viewport without reloading. Matching reruns include advisory before/after observations; results still need review. Browser sandboxing stays enabled.",
      inputSchema: z
        .object({
          ...productSelectionInput,
          journey: browserJourneySchema.optional(),
          replay: z.string().min(1).optional(),
          binary: z.string().optional(),
          detail: z.boolean().optional(),
        })
        .strict(),
    },
    async (args) => {
      const state = await mutatingWorkspaceFor(root);
      return state.ok
        ? productReply("visp_capture", await runProductCapture(state.value, args), args.detail)
        : failure("visp_capture", state.error);
    },
  );
}
