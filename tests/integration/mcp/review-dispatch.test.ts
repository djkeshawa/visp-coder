import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../../../src/mcp/server.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

describe.each(["minimal", "standard"] as const)("%s profile review dispatch", (profile) => {
  it.each([false, true])("preserves host sampling capability: %s", async (sampling) => {
    const { workspace } = await productWorkspace();
    const client = new Client(
      { name: "review-client", version: "1" },
      { capabilities: sampling ? { sampling: {} } : {} },
    );
    let requests = 0;
    if (sampling) {
      client.setRequestHandler(CreateMessageRequestSchema, async ({ params }) => {
        requests += 1;
        expect(params.includeContext).toBe("none");
        const content = params.messages[0]?.content;
        const text = Array.isArray(content)
          ? content.find((entry) => entry.type === "text")
          : content;
        if (text?.type !== "text") throw new Error("Missing review context");
        const request = JSON.parse(text.text);
        return {
          role: "assistant",
          model: "test-reviewer",
          content: { type: "text", text: JSON.stringify(request.submission) },
        };
      });
    }
    const server = createServer(workspace.root, profile);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: "visp_review", arguments: { dispatch: true } });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(requests).toBe(sampling ? 1 : 0);
      const review = await client.callTool({ name: "visp_review", arguments: {} });
      const detailed = await client.callTool({ name: "visp_review", arguments: { detail: true } });
      expect(review.structuredContent).toEqual(detailed.structuredContent);
      expect(review.content).toEqual(
        expect.arrayContaining([
          { type: "text", text: expect.stringContaining("structuredContent.data") },
        ]),
      );
      expect(JSON.stringify(review).length).toBeLessThan(JSON.stringify(detailed).length * 0.7);
      expect(JSON.stringify(review.structuredContent)).toContain(
        sampling ? "fresh" : "No host reviewer adapter is available",
      );
    } finally {
      await client.close();
      await server.close();
      await workspace.destroy();
    }
  });
});
