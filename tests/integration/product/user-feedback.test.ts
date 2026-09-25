import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildProgram } from "../../../src/cli/program.js";
import { createServer } from "../../../src/mcp/server.js";
import {
  mcpUserFeedbackHost,
  registerUserFeedbackTool,
} from "../../../src/mcp/tools/user-feedback.js";
import { runProductCritic } from "../../../src/workflow/product/critic.js";
import { runJson } from "../../unit/cli/support/cli.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

let p: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  p = await productWorkspace({ critic: true });
});
afterEach(async () => {
  await p.workspace.destroy();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
function tool(form = false) {
  let callback: (args: Record<string, unknown>) => Promise<CallToolResult>;
  const elicitInput = vi.fn(async (_params: unknown, _options: unknown) => ({
    action: "accept",
    content: { feedback: "Make the primary control easier to find." },
  }));
  const server = {
    registerTool(_name: string, _config: unknown, handler: typeof callback) {
      callback = handler;
    },
    server: {
      getClientCapabilities: () => (form ? { elicitation: { form: {} } } : {}),
      elicitInput,
    },
  } as unknown as McpServer;
  registerUserFeedbackTool(server, p.workspace.root);
  return {
    elicitInput,
    call: async (args: Record<string, unknown>) =>
      (await callback(args)).structuredContent as { ok: boolean; data?: Record<string, unknown> },
  };
}
it("shares native question handoff and verbatim reply across CLI and MCP", async () => {
  const configured = await runJson(p.workspace.root, "critic", "--mode", "manual");
  expect(configured.envelope.data).toMatchObject({ mode: "manual", enabled: false, manual: true });
  const mcp = tool();
  const before = await mcp.call({ operation: "status", task: "T001" });
  expect(
    (await runJson(p.workspace.root, "critic", "feedback", "--task", "T001")).envelope.data,
  ).toEqual(before.data);
  const asked = await runJson(
    p.workspace.root,
    "critic",
    "feedback",
    "--task",
    "T001",
    "--ask",
    "How does this feel?",
  );
  expect(asked.exitCode).toBe(0);
  const id = (asked.envelope.data as { id: string }).id;
  expect(
    (await mcp.call({ operation: "ask", task: "T001", question: "Again?" })).data,
  ).toMatchObject({ id, delivery: "native-handoff", dispatch: false });
  expect(
    (
      await mcp.call({
        operation: "reply",
        task: "T001",
        id,
        reply: "The controls should be larger.",
      })
    ).data,
  ).toMatchObject({
    status: "answered",
    reply: "The controls should be larger.",
    provenance: "caller-reported",
  });
  expect(mcp.elicitInput).not.toHaveBeenCalled();
});
it("uses standard MCP user elicitation without sampling or an external reviewer", async () => {
  await runProductCritic(await p.workspace.state(), { operation: "set-policy", mode: "manual" });
  const mcp = tool(true);
  expect(
    (await mcp.call({ operation: "ask", task: "T001", question: "What should improve?" })).data,
  ).toMatchObject({
    status: "answered",
    provenance: "host-elicited",
    reply: "Make the primary control easier to find.",
  });
  expect(mcp.elicitInput).toHaveBeenCalledOnce();
  expect(mcp.elicitInput.mock.calls[0]?.[0]).toMatchObject({
    mode: "form",
    requestedSchema: { required: ["feedback"] },
  });
});
it("does not claim form support for unavailable or URL-only elicitation and treats decline as deferral", async () => {
  for (const capabilities of [{}, { elicitation: { url: {} } }])
    expect(
      mcpUserFeedbackHost({
        server: { getClientCapabilities: () => capabilities },
      } as unknown as McpServer),
    ).toBeUndefined();
  const elicitInput = vi.fn(async () => ({ action: "decline" }));
  const host = mcpUserFeedbackHost({
    server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput },
  } as unknown as McpServer);
  expect(
    await host?.ask(
      {
        id: "request",
        originalRequest: "Build a game",
        objective: "First shot",
        question: "How does it feel?",
      },
      {},
    ),
  ).toEqual({ action: "defer" });
});
it("routes an embedded CLI question through the supplied user host", async () => {
  await runProductCritic(await p.workspace.state(), { operation: "set-policy", mode: "manual" });
  const ask = vi.fn(async () => ({
    action: "answer" as const,
    text: "Keep the current direction.",
  }));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await buildProgram({ userFeedbackHost: { ask } }).parseAsync(
    [
      "--project",
      p.workspace.root,
      "--json",
      "critic",
      "feedback",
      "--task",
      "T001",
      "--ask",
      "Continue this direction?",
    ],
    { from: "user" },
  );
  expect(ask).toHaveBeenCalledOnce();
});

it("delivers a real MCP elicitation request through the minimal server and records the client reply", async () => {
  await runProductCritic(await p.workspace.state(), { operation: "set-policy", mode: "manual" });
  const server = createServer(p.workspace.root, "minimal");
  const client = new Client(
    { name: "feedback-test", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const receive = vi.fn(async () => ({
    action: "accept" as const,
    content: { feedback: "Keep the layout, improve the result message." },
  }));
  client.setRequestHandler(ElicitRequestSchema, receive);
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({
      name: "visp_user_feedback",
      arguments: { operation: "ask", task: "T001", question: "What should improve?" },
    });
    expect(receive).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        status: "answered",
        provenance: "host-elicited",
        reply: "Keep the layout, improve the result message.",
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
