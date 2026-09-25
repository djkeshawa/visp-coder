import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../../../src/mcp/server.js";
import type { ProductBriefUpdateResult } from "../../../src/workflow/product/brief.js";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { runJson } from "../cli/support/cli.js";
import { TestWorkspace } from "../support/workspace.js";

const corpus: { cases: { brief: Record<string, unknown> }[] } = JSON.parse(
  readFileSync(
    new URL("../../fixtures/product-briefs/rejected-2026-09-20.json", import.meta.url),
    "utf8",
  ),
);

let workspace: TestWorkspace | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await workspace?.destroy();
  client = undefined;
  workspace = undefined;
});

async function connected(): Promise<{ client: Client; brief: ProductBrief }> {
  workspace = await TestWorkspace.create();
  await workspace.installFoundation();
  workspace.commit("foundation");
  const created = await runJson<{ brief: ProductBrief }>(workspace.root, "feature", "Play a game");
  const brief = created.envelope.data?.brief;
  if (!brief) throw new Error(JSON.stringify(created.envelope));
  const server = createServer(workspace.root);
  client = new Client({ name: "brief-authoring-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, brief };
}

it("keeps the resident brief tool definition small", async () => {
  const { client } = await connected();
  const { tools } = await client.listTools();
  const definition = tools.find((tool) => tool.name === "visp_brief");
  expect(definition).toBeDefined();
  // Every turn re-reads tool definitions; the full brief schema was 15.9k characters.
  expect(JSON.stringify(definition).length).toBeLessThan(2_500);
});

it("accepts a real rejected brief over MCP and reports what it normalized", async () => {
  const { client, brief } = await connected();
  const authored = corpus.cases[2]?.brief ?? {};
  const response = (await client.callTool({
    name: "visp_brief",
    arguments: {
      brief: { ...authored, feature: brief.feature, originalRequest: brief.originalRequest },
      reason: "Define the first playable slice",
    },
  })) as CallToolResult;
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const data = (response.structuredContent as { data: ProductBriefUpdateResult }).data;
  expect(data.slices.map((slice) => slice.id)).toEqual(["T001", "T002"]);
  expect(data.normalized?.length).toBeGreaterThan(0);
});

it("still rejects an invalid brief with field paths after the loose MCP boundary", async () => {
  const { client, brief } = await connected();
  const response = (await client.callTool({
    name: "visp_brief",
    arguments: {
      brief: {
        ...brief,
        outcomes: [{ kind: "banana", statement: "A result" }],
      },
    },
  })) as CallToolResult;
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain("outcomes.0.kind");
});
