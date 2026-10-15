import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { discoverProjectRoot } from "../../core/project-root.js";
import { ok } from "../../core/result.js";
import {
  evaluateGuardRequest,
  type GuardPayload,
  pendingTransactionRefusal,
} from "../../orchestrate/guard-evaluation.js";
import { PENDING_REVIEW_MESSAGE } from "../../workflow/product/critic/critic-policy.js";
import { TOOL } from "../constants.js";
import { workspaceFor } from "../context.js";
import { failure, reply } from "../reply.js";
import { guardInput } from "./schemas.js";

/**
 * The question an agent should ask before writing: may I touch this file? It
 * runs the same decision `visp guard --path` runs for the hooks and CI, so a
 * refusal here is the same refusal it would hit later.
 */
export function registerScopeTools(server: McpServer, root: string): void {
  server.registerTool(
    TOOL.guard,
    {
      title: "Check paths against the authorized scope",
      description: "Ask whether the given paths may be written. Call this before editing any file.",
      inputSchema: guardInput,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const transactions = await pendingTransactionRefusal(discoverProjectRoot(root));
      if (!transactions.ok) return failure(TOOL.guard, transactions.error);
      if (transactions.value) {
        const { saving, payload } = transactions.value;
        const message = payload.violations[0]?.message ?? "";
        return reply(TOOL.guard, ok(payload), {
          text: () => (saving ? message : `${message}. Run \`visp doctor --fix\` in a shell.`),
        });
      }
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.guard, state.error);
      const evaluated = await evaluateGuardRequest(state.value, { paths: args.paths });
      if (!evaluated.ok) return failure(TOOL.guard, evaluated.error);
      return reply(TOOL.guard, ok(evaluated.value.payload), {
        text: (data) =>
          data.allowed ? `All ${data.checked} paths are in scope.` : refusalText(data),
      });
    },
  );
}

function refusalText(data: GuardPayload): string {
  const closing = data.violations.some((violation) => violation.reason === "review-pending")
    ? `${PENDING_REVIEW_MESSAGE}.`
    : data.committable?.length
      ? `${data.committable.length} of these belong to a task that is already closed; editing them needs a new authorized task.`
      : data.authorizedTasks.length === 0
        ? "No task is authorized. Run: visp_next {}"
        : `Authorized tasks: ${data.authorizedTasks.join(", ")}`;
  return [
    `Refused: ${data.violations.length} of ${data.checked} paths are out of scope.`,
    ...data.violations.map((violation) => `  - ${violation.message}`),
    "",
    closing,
  ].join("\n");
}
