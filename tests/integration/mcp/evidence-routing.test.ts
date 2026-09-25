import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL } from "../../../src/mcp/constants.js";
import { productCheckTemplate } from "../../../src/workflow/product/check-guidance.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { startProductProject } from "./resource-fixture.js";

describe("MCP product evidence feedback", () => {
  let project: Awaited<ReturnType<typeof startProductProject>>;
  beforeEach(async () => {
    project = await startProductProject();
  });
  afterEach(async () => {
    await project.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    return project.client.callTool({ name, arguments: args });
  }
  function data(result: unknown): Record<string, unknown> {
    const payload = (result as CallToolResult).structuredContent as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(payload?.ok).toBe(true);
    return payload.data;
  }
  async function stateBytes() {
    return readFile(
      join(project.root, ".visp/features", project.brief.feature, "product-state.json"),
      "utf8",
    );
  }

  it("shares read-only check examples with the CLI service", async () => {
    for (const checkTemplate of ["command", "browser"]) {
      const expected = await productCheckTemplate(await project.workspace.state(), checkTemplate);
      if (!expected.ok) throw new Error(expected.error.message);
      expect(data(await call(TOOL.brief, { checkTemplate }))).toEqual(expected.value);
    }
    expect(await call(TOOL.brief, { checkTemplate: "browser", template: true })).toMatchObject({
      isError: true,
    });
  });

  it("returns actual failures, then closes and accepts the corrected usable behavior", async () => {
    expect(data(await call(TOOL.work, { task: "T001" }))).toMatchObject({
      mayEdit: true,
      task: "T001",
    });
    const failed = data(await call(TOOL.verify, { task: "T001" }));
    expect(failed).toMatchObject({
      passed: false,
      executions: [
        {
          check: "C001",
          status: "failed",
          provenance: "supervisor-executed",
          exitCode: 1,
          output: expect.stringContaining("the promised value"),
        },
      ],
    });
    expect(data(await call(TOOL.next))).toMatchObject({
      action: "fix",
      mayEdit: true,
      evidence: [expect.stringContaining("C001: failed")],
      command: `visp work --feature ${project.brief.feature} --task T001`,
    });
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(data(await call(TOOL.verify, { task: "T001" }))).toMatchObject({
      passed: true,
      behaviorChanges: { checks: [{ check: "C001", change: "recovered-execution" }], omitted: 0 },
    });
    expect(data(await call(TOOL.done, { task: "T001" }))).toMatchObject({
      passed: true,
      closed: true,
      executions: [],
    });
    expect(data(await call(TOOL.next))).toMatchObject({ action: "refine", mayEdit: false });
    const review = data(await call(TOOL.review));
    await call(TOOL.review, {
      subjectDigest: review.subjectDigest,
      feedback: moduleFeedback(review as unknown as ProductReviewBundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary:
            "The executed public import returns two; the original value of one failed this same observable equality check.",
          evidence: (review.executions as { id: string }[]).map((execution) => execution.id),
        },
      ],
    });
    expect(data(await call(TOOL.accept))).toMatchObject({ passed: true });
    expect(data(await call(TOOL.next))).toMatchObject({ action: "complete", mayEdit: false });
  });

  it("requests a different hypothesis for recurring product failures despite metadata edits", async () => {
    await call(TOOL.work, { task: "T001" });
    await call(TOOL.verify, { task: "T001" });
    await project.workspace.write(".visp/reviewer-notes.md", "Changed bookkeeping only\n");
    expect(data(await call(TOOL.verify, { task: "T001" }))).toMatchObject({
      passed: false,
      recommendation: expect.stringContaining("different hypothesis"),
    });
  });

  it("rejects unknown task selections before executing or recording evidence", async () => {
    await call(TOOL.work, { task: "T001" });
    const before = await stateBytes();
    for (const name of [TOOL.work, TOOL.verify, TOOL.review, TOOL.done, TOOL.next]) {
      const result = await call(name, { task: "T999" });
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toMatchObject({ error: { code: "TASK_NOT_FOUND" } });
    }
    expect(await stateBytes()).toBe(before);
  });

  it("routes replay and mutually exclusive capture input through the shared validator", async () => {
    for (const args of [
      { replay: "missing", task: "T001" },
      { replay: "missing", journey: { url: "http://127.0.0.1/" } },
      {},
    ]) {
      const result = await call("visp_capture", args);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
  });

  it("rejects retired execution-control arguments at the transport boundary", async () => {
    await call(TOOL.work, { task: "T001" });
    const before = await stateBytes();
    for (const name of [TOOL.verify, TOOL.done, TOOL.accept]) {
      const result = await call(name, { skipCommands: true });
      expect(result.isError, name).toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([{ type: "text", text: expect.stringContaining("skipCommands") }]),
      );
    }
    expect(await stateBytes()).toBe(before);
  });
});
