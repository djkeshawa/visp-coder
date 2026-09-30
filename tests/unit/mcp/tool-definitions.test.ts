import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import { createServer } from "../../../src/mcp/server.js";
import { saveOverrides } from "../../../src/workflow/state.js";
import { authorize, withProductFeature } from "../cli/support/product-fixtures.js";
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

it("limits the critic tool's review restriction to review calls", async () => {
  const { tools } = await (await connected()).listTools();
  const description = tools.find((tool) => tool.name === "visp_critic")?.description ?? "";
  expect(description).toContain(
    "Review calls: make them only when visp_next returns one; VISP-launched reviews run inside visp_done. set-policy and recovery follow the user's request.",
  );
});

it("does not let an MCP caller choose the browser executable", async () => {
  const { tools } = await (await connected()).listTools();
  const capture = tools.find((tool) => tool.name === "visp_capture");
  expect(capture?.inputSchema.properties).not.toHaveProperty("binary");
});

it("uses the CLI's allowed-files override and protects VISP state", async () => {
  const connectedClient = await connected();
  if (!workspace) throw new Error("Missing workspace");
  await withProductFeature(workspace, "001-mcp-guard");
  await authorize(workspace, { feature: "001-mcp-guard", task: "T001" });
  const state = await workspace.state();
  const saved = await saveOverrides(state.paths, [
    {
      id: "OV001",
      rule: "scope.allowed-files",
      reason: "Permit this extra source file for the task",
      scope: {},
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  ]);
  expect(saved.ok).toBe(true);
  const outside = await connectedClient.callTool({
    name: "visp_guard",
    arguments: { paths: ["docs/extra.md"] },
  });
  expect((outside.structuredContent as { data?: unknown })?.data).toMatchObject({ allowed: true });
  const statePath = await connectedClient.callTool({
    name: "visp_guard",
    arguments: { paths: [".visp/features/x/brief.yaml"] },
  });
  expect((statePath.structuredContent as { data?: unknown })?.data).toMatchObject({
    violations: [{ reason: "protected-path" }],
  });
});

it("refuses a guard decision while a transaction is pending", async () => {
  const connectedClient = await connected();
  if (!workspace) throw new Error("Missing workspace");
  await applyFileTransaction(
    workspace.root,
    "interrupted-guard",
    [{ kind: "write", path: "partial.txt", content: "partial" }],
    {
      afterMutation() {
        throw new Error("simulated crash");
      },
      leavePreparedOnError: true,
    },
  );
  const result = await connectedClient.callTool({
    name: "visp_guard",
    arguments: { paths: ["src/app.ts"] },
  });
  expect((result.structuredContent as { data?: unknown })?.data).toMatchObject({
    violations: [{ reason: "transaction-pending" }],
  });
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
