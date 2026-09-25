import { readFile, writeFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { registerEvidenceTools } from "../../../src/mcp/tools/evidence.js";
import { registerWorkflowTools } from "../../../src/mcp/tools/workflow.js";
import { productBriefSchema } from "../../../src/workflow/product/model.js";
import { runJson } from "../cli/support/cli.js";
import { productWorkspace } from "../support/product-workspace.js";
import type { TestWorkspace } from "../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.destroy()));
});

it("CLI and MCP return identical editable inputs without mutation", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (args: unknown) => Promise<CallToolResult>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerWorkflowTools(server, workspace.root);
  registerEvidenceTools(server, workspace.root);
  const state = await workspace.state();
  const path = `.visp/features/${brief.feature}/product-state.json`;
  const before = await state.files.readText(path);
  for (const name of ["brief", "review"]) {
    const handler = handlers.get(`visp_${name}`);
    if (!handler) throw new Error(`missing ${name}`);
    const mcp = await handler({ template: true });
    const cli = await runJson(workspace.root, name, "--template");
    expect(mcp.isError).not.toBe(true);
    expect((mcp.structuredContent as { data: unknown }).data).toEqual(cli.envelope.data);
    if (name === "brief") {
      const text = mcp.content
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n");
      const example = text.match(/```yaml\n([\s\S]*?)```/)?.[1];
      expect(example).toBeDefined();
      // Direct Codex tool calls prefer structuredContent over text blocks.
      const delivered = mcp.structuredContent as { data: unknown; guidance: string };
      expect(delivered.guidance.match(/```yaml\n([\s\S]*?)```/)?.[1]).toEqual(example);
      expect(delivered.guidance).toContain("originalRequest and acceptanceBaseline");
      expect(delivered.data).not.toHaveProperty("guidance");
      const authored = productBriefSchema.parse({ ...brief, ...parse(example ?? "") });
      expect(authored.slices[0]?.checks).toEqual([authored.checks[0]?.id]);
      expect(authored.slices[0]?.scope.allowed).toContain("server.mjs");
    }
    const conflict = await handler({
      template: true,
      ...(name === "brief" ? { brief } : { assessments: [] }),
    });
    expect(conflict.isError).toBe(true);
  }
  const review = handlers.get("visp_review");
  if (!review) throw new Error("Missing review tool");
  const mcpReview = await review({});
  const cliReview = await runJson(workspace.root, "review");
  const mcpData = (
    mcpReview.structuredContent as { data: { agenda: unknown; interactionEvidence: unknown } }
  ).data;
  const cliData = cliReview.envelope.data as { agenda: unknown; interactionEvidence: unknown };
  expect(mcpData.agenda).toEqual(cliData.agenda);
  expect(mcpData.interactionEvidence).toEqual(cliData.interactionEvidence);
  expect(await state.files.readText(path)).toEqual(before);

  const work = handlers.get("visp_work");
  if (!work) throw new Error("Missing work tool");
  const inspect = await work({ inspect: true, detail: true });
  expect(inspect.structuredContent).toMatchObject({
    data: { mayEdit: false, scope: brief.slices[0]?.scope },
  });
  expect(await state.files.readText(path)).toEqual(before);
  const compactWork = await work({});
  const detailedWork = await work({ detail: true });
  expect(compactWork.isError).not.toBe(true);
  expect(compactWork.structuredContent).toEqual(detailedWork.structuredContent);
  expect(compactWork.structuredContent).toMatchObject({
    data: { mayEdit: true, scope: brief.slices[0]?.scope, checks: brief.checks },
  });
  expect(JSON.stringify(compactWork).length).toBeLessThan(
    JSON.stringify(detailedWork).length * 0.7,
  );
});

it("uses the same partial-brief merge from CLI and MCP", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  registerWorkflowTools(
    {
      registerTool(
        name: string,
        _config: unknown,
        handler: (args: unknown) => Promise<CallToolResult>,
      ) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    workspace.root,
  );
  const patch = { slices: [{ id: "T001", approach: "Trace the public caller first" }] };
  const handler = handlers.get("visp_brief");
  if (!handler) throw new Error("Missing brief tool");
  const mcp = await handler({ patch, reason: "Clarify the repair approach" });
  expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
  await workspace.write(".visp/patch.json", JSON.stringify(patch));
  const cli = await runJson(
    workspace.root,
    "brief",
    "--patch",
    ".visp/patch.json",
    "--reason",
    "Clarify the repair approach",
  );
  expect(cli.envelope.ok).toBe(true);
  expect(cli.envelope.data).toEqual((mcp.structuredContent as { data: unknown }).data);
  expect(cli.envelope.data).toMatchObject({
    originalRequest: brief.originalRequest,
    acceptanceBaseline: brief.acceptanceBaseline,
  });
  const conflict = await handler({ brief, patch });
  expect(conflict.isError).toBe(true);
  const state = await workspace.state();
  const path = `.visp/features/${brief.feature}/product-state.json`;
  const before = await state.files.readText(path);
  expect((await handler({ checkTemplate: "command", patch })).isError).toBe(true);
  const cliConflict = await runJson(
    workspace.root,
    "brief",
    "--check-template",
    "command",
    "--patch",
    ".visp/patch.json",
  );
  expect(cliConflict.envelope.ok).toBe(false);
  expect(await state.files.readText(path)).toEqual(before);
});

it("CLI and MCP prepare and submit sessions through the same engine", async () => {
  const { workspace } = await productWorkspace();
  workspaces.push(workspace);
  const handlers = new Map<string, (args: unknown) => Promise<CallToolResult>>();
  const server = {
    registerTool(
      name: string,
      _config: unknown,
      handler: (args: unknown) => Promise<CallToolResult>,
    ) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerEvidenceTools(server, workspace.root);
  const handler = handlers.get("visp_review");
  if (!handler) throw new Error("Missing review");
  const cli = await runJson<{ session: string; packetPath: string }>(
    workspace.root,
    "review",
    "--prepare",
    "--task",
    "T001",
  );
  expect(cli.exitCode).toBe(0);
  const session = cli.envelope.data?.session;
  expect(session).toBeTruthy();
  if (!cli.envelope.data) throw new Error("No session");
  const packet = JSON.parse(await readFile(cli.envelope.data.packetPath, "utf8"));
  const submitted = await handler({ session, task: "T001", response: packet.submission });
  expect(submitted.isError).not.toBe(true);
  const prepared = await handler({ prepare: true, task: "T001" });
  const data = (
    prepared.structuredContent as {
      data: { session: string; responsePath: string; packetPath: string };
    }
  ).data;
  const secondPacket = JSON.parse(await readFile(data.packetPath, "utf8"));
  await writeFile(data.responsePath, JSON.stringify(secondPacket.submission));
  const result = await runJson(
    workspace.root,
    "review",
    "--session",
    data.session,
    "--task",
    "T001",
    "--from",
    data.responsePath,
  );
  expect(result.exitCode).toBe(0);
});
