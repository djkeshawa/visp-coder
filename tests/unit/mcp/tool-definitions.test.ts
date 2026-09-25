import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../../../src/mcp/server.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await workspace?.destroy();
  client = undefined;
  workspace = undefined;
});

async function connected(): Promise<Client> {
  workspace = await TestWorkspace.create();
  await workspace.installFoundation();
  workspace.commit("foundation");
  const server = createServer(workspace.root);
  client = new Client({ name: "tool-definitions-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

// Definitions are re-read on every model turn. On 2026-09-23 the default profile carried
// 44k characters, 26k of them in the brief and review schemas. The capture journey schema
// stays resident because models author journeys directly from it.
it("keeps the default profile's resident tool definitions bounded", async () => {
  const { tools } = await (await connected()).listTools();
  const review = tools.find((tool) => tool.name === "visp_review");
  expect(JSON.stringify(review).length).toBeLessThan(3_000);
  expect(JSON.stringify(tools).length).toBeLessThan(30_000);
});

it("still validates review judgments against the full schema in the handler", async () => {
  const response = (await (
    await connected()
  ).callTool({
    name: "visp_review",
    arguments: { assessments: [{ outcome: "O001", status: "great" }], subjectDigest: "x" },
  })) as CallToolResult;
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain("assessments.0.status");
});
