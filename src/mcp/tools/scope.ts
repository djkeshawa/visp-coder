import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRODUCT_NAME } from "../../core/constants.js";
import { ok } from "../../core/result.js";
import { runtimeIdentity } from "../../core/version.js";
import { requireInstalledRuntime } from "../../harness/runtime.js";
import {
  evaluateGuardPaths,
  pendingTransactionViolations,
} from "../../orchestrate/guard-evaluation.js";
import { productScopes as authorizedScopes } from "../../workflow/product/scopes.js";
import { TOOL } from "../constants.js";
import { workspaceFor } from "../context.js";
import { failure, reply } from "../reply.js";
import { guardInput } from "./schemas.js";

/**
 * The question an agent should ask before writing: may I touch this file? It
 * calls the same decision the hooks and CI call, so a refusal here is the same
 * refusal it would hit later.
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
      const transactions = await pendingTransactionViolations(root);
      if (!transactions.ok) return failure(TOOL.guard, transactions.error);
      if (transactions.value.length) return guardReply(args.paths, transactions.value, []);
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.guard, state.error);

      const markers = await authorizedScopes(state.value);
      if (!markers.ok) return failure(TOOL.guard, markers.error);
      if (markers.value.length > 0) {
        const agreed = await requireInstalledRuntime(state.value.paths, state.value.files);
        if (!agreed.ok) return failure(TOOL.guard, agreed.error);
      }

      const guarded = await evaluateGuardPaths(state.value, args.paths, markers.value, {
        writeTime: true,
      });
      if (!guarded.ok) return failure(TOOL.guard, guarded.error);
      return guardReply(
        args.paths,
        guarded.value,
        markers.value.map((marker) => marker.task),
      );
    },
  );
}

function guardReply(
  paths: readonly string[],
  violations: readonly {
    readonly path: string;
    readonly reason: string;
    readonly message: string;
  }[],
  authorizedTasks: readonly string[],
) {
  const payload = {
    runtime: runtimeIdentity(),
    checked: paths.length,
    allowed: violations.length === 0,
    violations,
    authorizedTasks,
  };
  return reply(TOOL.guard, ok(payload), {
    text: (data) =>
      data.allowed
        ? `All ${data.checked} paths are in scope.`
        : [
            `Refused: ${data.violations.length} of ${data.checked} paths are out of scope.`,
            ...data.violations.map((violation) => `  - ${violation.message}`),
            "",
            authorizedTasks.length === 0
              ? `No task is authorized. Run: ${PRODUCT_NAME} work --task <id>`
              : `Authorized tasks: ${authorizedTasks.join(", ")}`,
          ].join("\n"),
  });
}
