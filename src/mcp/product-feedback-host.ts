import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DEFAULT_HOST_FEEDBACK_TIMEOUT_MS,
  type ProductFeedbackHost,
} from "../workflow/product/host-feedback.js";
import { productReviewInstructions } from "../workflow/product/review-instructions.js";
import { productWithoutImageBytes } from "../workflow/product-presentation.js";

/** Sampling is an explicit host capability. No provider calls or model preference override. */
export function mcpProductFeedbackHost(server: McpServer): ProductFeedbackHost {
  return {
    model: "host-configured",
    ...(server.server.getClientCapabilities()?.sampling
      ? ({
          review: async (request, options) => {
            const { images, instructions, ...context } = request;
            const sampled = await server.server.createMessage(
              {
                includeContext: "none",
                maxTokens: 8192,
                systemPrompt: `${instructions ?? productReviewInstructions({ visual: images.length > 0 })}\nReturn only JSON matching responseSchema. Use the host's configured model.`,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: JSON.stringify(productWithoutImageBytes(context)) },
                      ...images.map((image) => ({
                        type: "image" as const,
                        data: image.data,
                        mimeType: image.mimeType,
                      })),
                    ],
                  },
                ],
              },
              {
                signal: options.signal,
                timeout: options.timeoutMs ?? DEFAULT_HOST_FEEDBACK_TIMEOUT_MS,
              },
            );
            if (sampled.content.type !== "text")
              throw new Error("Host review returned no JSON text");
            return JSON.parse(sampled.content.text);
          },
        } satisfies Pick<ProductFeedbackHost, "review">)
      : {}),
  };
}
