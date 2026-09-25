import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRODUCT_NAME } from "../../core/constants.js";
import { ok, type Result } from "../../core/result.js";
import { runtimeIdentity } from "../../core/version.js";
import { requireInstalledRuntime } from "../../harness/runtime.js";
import { checkPaths, type ScopeViolation } from "../../orchestrate/guard.js";
import {
  hasPendingCriticReview,
  PENDING_REVIEW_MESSAGE,
} from "../../workflow/product/critic-policy.js";
import { productScopes as authorizedScopes } from "../../workflow/product/scopes.js";
import { isStatePath, type WorkspaceState } from "../../workflow/state.js";
import { TOOL } from "../constants.js";
import { workspaceFor } from "../context.js";
import { failure, reply } from "../reply.js";
import { guardInput } from "./schemas.js";

type ScopeToolViolation =
  | ScopeViolation
  | {
      readonly path: string;
      readonly reason: "review-pending";
      readonly message: string;
    };

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
      const state = await workspaceFor(root);
      if (!state.ok) return failure(TOOL.guard, state.error);

      const markers = await authorizedScopes(state.value);
      if (!markers.ok) return failure(TOOL.guard, markers.error);
      if (markers.value.length > 0) {
        const agreed = await requireInstalledRuntime(state.value.paths, state.value.files);
        if (!agreed.ok) return failure(TOOL.guard, agreed.error);
      }

      const violations: ScopeToolViolation[] = checkPaths(args.paths, {
        markers: markers.value,
        blockedPaths: state.value.config.workflow.blockedPaths,
      });
      const guarded = await pendingReviewViolations(
        state.value,
        markers.value[0]?.feature,
        args.paths,
        violations,
      );
      if (!guarded.ok) return failure(TOOL.guard, guarded.error);
      const checkedViolations = guarded.value;

      const authorizedTasks = markers.value.map((marker) => marker.task);
      const payload = {
        runtime: runtimeIdentity(),
        checked: args.paths.length,
        allowed: checkedViolations.length === 0,
        violations: checkedViolations,
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
    },
  );
}

async function pendingReviewViolations(
  state: WorkspaceState,
  feature: string | undefined,
  paths: readonly string[],
  violations: readonly ScopeToolViolation[],
): Promise<Result<ScopeToolViolation[]>> {
  if (!feature || paths.length === 0) return ok([...violations]);
  const pending = await hasPendingCriticReview(state, feature);
  if (!pending.ok) return pending;
  if (!pending.value) return ok([...violations]);
  const alreadyRefused = new Set(violations.map((violation) => violation.path));
  return ok([
    ...violations,
    ...paths
      .filter((path) => !alreadyRefused.has(path) && !isStatePath(path))
      .map((path) => ({
        path,
        reason: "review-pending" as const,
        message: PENDING_REVIEW_MESSAGE,
      })),
  ]);
}
