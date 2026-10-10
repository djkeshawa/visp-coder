import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ProductSelection } from "../workflow/product/store.js";

export function mcpOperationOptions(
  extra?: RequestHandlerExtra<ServerRequest, ServerNotification>,
): ProductSelection {
  let progress = 0;
  return {
    signal: extra?.signal,
    deadline: Date.now() + 50_000,
    onProgress: async (event) => {
      const progressToken = extra?._meta?.progressToken;
      if (progressToken === undefined || extra?.signal.aborted) return;
      await extra
        ?.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: ++progress,
            message: `${event.check}: ${event.status}`,
          },
        })
        .catch(() => undefined);
    },
  };
}
