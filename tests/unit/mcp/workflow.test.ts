import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL } from "../../../src/mcp/constants.js";
import { registerWorkflowTools } from "../../../src/mcp/tools/workflow.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace, task } from "../support/workspace.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

function workflowTools(root: string): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const recorder = {
    registerTool(name: string, _config: unknown, callback: Handler) {
      handlers.set(name, callback);
      return {};
    },
  };
  registerWorkflowTools(recorder as unknown as McpServer, root);
  return handlers;
}

function handler(handlers: Map<string, Handler>, name: string): Handler {
  const found = handlers.get(name);
  if (!found) throw new Error(`${name} was not registered`);
  return found;
}

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.ts": "export const app = true;\n" });
});

afterEach(async () => {
  await workspace.destroy();
});

describe("MCP workflow adapters", () => {
  it("maps unsupported feature enums to structured errors before mutation", async () => {
    const feature = handler(workflowTools(workspace.root), TOOL.feature);

    for (const args of [
      { goal: "do work", riskLevel: "catastrophic" },
      { goal: "do work", workflow: "magic" },
    ]) {
      const result = await feature(args);
      const structured = result.structuredContent as
        | { ok?: boolean; error?: { code?: string } }
        | undefined;
      expect(result.isError).toBe(true);
      expect(structured).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    }
  });

  it("preserves the source request in one brief and replaces the drafting tools", async () => {
    await workspace.installFoundation();
    workspace.commit("install foundation");
    const handlers = workflowTools(workspace.root);
    const started = await handler(
      handlers,
      TOOL.feature,
    )({
      goal: "add login",
      sourceBrief: "Please add login",
      riskLevel: "low",
      workflow: "full",
    });
    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toMatchObject({
      data: { brief: { version: 2, originalRequest: "Please add login", goal: "add login" } },
    });
    const state = await workspace.state();
    const feature = state.status?.activeFeature;
    if (!feature) throw new Error("Feature was not created");
    const before = await state.files.readText(state.paths.featureFile(feature, "brief.yaml"));
    for (const name of ["visp_research", "visp_spec", "visp_plan", "visp_tasks"])
      expect(handlers.has(name), name).toBe(false);
    expect(await state.files.readText(state.paths.featureFile(feature, "brief.yaml"))).toEqual(
      before,
    );
    for (const file of ["research.json", "spec.json", "plan.json", "tasks.json"]) {
      expect(await state.files.exists(state.paths.featureFile(feature, file))).toMatchObject({
        ok: true,
        value: false,
      });
    }
  });

  it("delivers the usable slice and grants scope only through work", async () => {
    await workspace.destroy();
    ({ workspace } = await productWorkspace());
    const handlers = workflowTools(workspace.root);
    const next = await handler(handlers, TOOL.next)({});
    expect(next.structuredContent).toMatchObject({
      data: {
        action: "implement",
        task: "T001",
        objective: "Return the promised value",
        mayEdit: false,
      },
    });
    const work = await handler(handlers, TOOL.work)({ task: "T001" });
    expect(work.structuredContent).toMatchObject({
      data: {
        task: "T001",
        mayEdit: true,
        originalRequest: "Return two from the public module",
        outcomes: [{ id: "O001", statement: "The public value is two" }],
        scope: { allowed: ["src/value.mjs", "test/value.test.mjs"] },
        checks: [{ id: "C001" }],
      },
    });
    const status = await handler(handlers, TOOL.status)({});
    expect(status.structuredContent).toMatchObject({
      data: {
        next: { action: "implement", task: "T001", mayEdit: true },
      },
    });
    expect((status.structuredContent as { data: unknown }).data).not.toHaveProperty("state");
    const detailedStatus = await handler(handlers, TOOL.status)({ detail: true });
    expect(detailedStatus.structuredContent).toMatchObject({ data: { state: { executions: [] } } });
  });

  it("requires migration even when all historical tasks are done", async () => {
    await workspace.withFeature("001-complete", [task({ status: "done" })]);
    const result = await handler(workflowTools(workspace.root), TOOL.next)({});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      data: {
        action: "understand",
        feature: "001-complete",
        mayEdit: false,
        command: "visp migrate --feature 001-complete --dry-run",
        evidence: [expect.stringContaining("MIGRATION_REQUIRED")],
      },
    });
    const state = await workspace.state();
    expect(
      await state.files.exists(state.paths.featureFile("001-complete", "brief.yaml")),
    ).toMatchObject({ ok: true, value: false });
  });

  it("returns malformed brief failures from next and status", async () => {
    await workspace.destroy();
    const product = await productWorkspace();
    workspace = product.workspace;
    await workspace.write(`.visp/features/${product.brief.feature}/brief.yaml`, "{}\n");
    const handlers = workflowTools(workspace.root);
    for (const name of [TOOL.next, TOOL.status]) {
      const result = await handler(handlers, name)({});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        ok: false,
        error: { code: "ARTIFACT_INVALID" },
      });
    }
  });
});
