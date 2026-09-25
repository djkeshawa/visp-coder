import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { registerTools } from "../../../src/mcp/tools/index.js";
import type { ProductBrief } from "../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";
import { runCli, runJson } from "../../unit/cli/support/cli.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { TestWorkspace } from "../../unit/support/workspace.js";

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
function tools(root: string) {
  const handlers = new Map<string, Handler>();
  registerTools(
    {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    root,
  );
  return (name: string, args: Record<string, unknown> = {}) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Unregistered tool ${name}`);
    return handler(args);
  };
}

let project: TestWorkspace;
beforeEach(async () => {
  project = await TestWorkspace.create({
    "src/value.mjs": "export const value = 1;\n",
    "test/value.test.mjs":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,2));\n",
  });
  await project.installFoundation();
  project.commit("install project integration");
});
afterEach(async () => project.destroy());

async function begin() {
  const started = await runJson<{ brief: ProductBrief }>(
    project.root,
    "feature",
    "Return two from the public module",
  );
  expect(started.exitCode, JSON.stringify(started.envelope)).toBe(0);
  const brief = started.envelope.data?.brief;
  if (!brief) throw new Error("Feature did not return its brief");
  const authored = {
    ...brief,
    outcomes: [
      {
        id: "O001",
        kind: "functional",
        statement: "The public module returns two",
        priority: "must",
        provenance: "user-stated",
      },
    ],
    checks: [
      {
        id: "C001",
        command: [process.execPath, "--test", "test/value.test.mjs"],
        outcomes: ["O001"],
        files: ["src/value.mjs", "test/value.test.mjs"],
        environment: "node",
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Correct the public value",
        outcomes: ["O001"],
        scope: { allowed: ["src/value.mjs"], expected: ["src/value.mjs"], forbidden: [] },
        checks: ["C001"],
      },
    ],
  };
  await project.write(".visp/draft.yaml", stringify(authored));
  const updated = await runJson<ProductBrief>(
    project.root,
    "brief",
    "--from",
    ".visp/draft.yaml",
    "--reason",
    "Define the first complete behavior",
  );
  expect(updated.exitCode, JSON.stringify(updated.envelope)).toBe(0);
  if (!updated.envelope.data) throw new Error("Brief update returned no data");
  return updated.envelope.data;
}

describe("shared product interfaces", () => {
  it("uses one brief through context, scope, real verification and closure without stage artifacts", async () => {
    const brief = await begin();
    const call = tools(project.root);
    const before = await readFile(
      join(project.root, ".visp/features", brief.feature, "product-state.json"),
      "utf8",
    );
    const next = await runJson(project.root, "next");
    const remote = await call("visp_next");
    expect((remote.structuredContent as { data: unknown }).data).toEqual(next.envelope.data);
    expect(
      await readFile(
        join(project.root, ".visp/features", brief.feature, "product-state.json"),
        "utf8",
      ),
    ).toBe(before);
    const work = await call("visp_work", { task: "T001" });
    expect(work.isError, JSON.stringify(work.structuredContent)).not.toBe(true);
    const guard = await runJson<{ allowed: boolean }>(
      project.root,
      "guard",
      "--path",
      "src/value.mjs",
    );
    expect(guard.envelope.data?.allowed).toBe(true);
    const outOfScope = await runJson<{ allowed: boolean }>(
      project.root,
      "guard",
      "--path",
      "src/unrelated.mjs",
    );
    expect(outOfScope.envelope.data?.allowed).toBe(false);
    const failed = await runJson(project.root, "done", "--task", "T001");
    expect(failed.exitCode).not.toBe(0);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const done = await runJson(project.root, "done", "--task", "T001");
    expect(done.exitCode, JSON.stringify(done.envelope)).toBe(0);
    const bundle = await call("visp_review");
    const reviewed = (bundle.structuredContent as { data: ProductReviewBundle }).data;
    await call("visp_review", {
      subjectDigest: reviewed.subjectDigest,
      feedback: moduleFeedback(reviewed),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary:
            "The public module now exports two; the same independent import-and-equality check failed for one and passes for two.",
          evidence: reviewed.executions.map((execution) => execution.id),
        },
      ],
    });
    const accepted = await call("visp_accept");
    expect(accepted.isError, JSON.stringify(accepted.structuredContent)).not.toBe(true);
    expect(accepted.structuredContent).toMatchObject({ data: { passed: true } });
    const files = await readdir(join(project.root, ".visp/features", brief.feature));
    for (const name of ["research.json", "spec.json", "plan.json", "tasks.json"])
      expect(files).not.toContain(name);
  });

  it("refuses unknown tasks consistently before execution or mutation", async () => {
    const brief = await begin();
    const statePath = join(project.root, ".visp/features", brief.feature, "product-state.json");
    const before = await readFile(statePath, "utf8");
    const cli = await runJson(project.root, "verify", "--task", "T999");
    const mcp = await tools(project.root)("visp_verify", { task: "T999" });
    expect(cli.envelope.error?.code).toBe("TASK_NOT_FOUND");
    expect(mcp.structuredContent).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("retired CLI/MCP stages cannot recreate authored artifacts", async () => {
    const brief = await begin();
    const directory = join(project.root, ".visp/features", brief.feature);
    const before = await readdir(directory);
    const call = tools(project.root);
    for (const name of ["research", "spec", "plan", "tasks"]) {
      const cli = await runCli(project.root, name, "--validate");
      expect(cli.exitCode, name).not.toBe(0);
      expect(() => call(`visp_${name}`, { validate: true })).toThrow("Unregistered tool");
    }
    expect(await readdir(directory)).toEqual(before);
  });
});
