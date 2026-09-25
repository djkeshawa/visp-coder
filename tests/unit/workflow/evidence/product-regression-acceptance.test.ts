import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { registerEvidenceTools } from "../../../../src/mcp/tools/evidence.js";
import { outstandingFeedback } from "../../../../src/workflow/product/feedback.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runJson } from "../../cli/support/cli.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

type Project = Awaited<ReturnType<typeof productWorkspace>>;
const projects: Project[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.workspace.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function acceptance(project: Project, transport: "service" | "cli" | "mcp", blocked = true) {
  if (transport === "service") {
    const result = await runProductAccept(await project.workspace.state());
    if (blocked) {
      expect(result).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
      return { passed: false };
    }
    return value(result);
  }
  if (transport === "cli") {
    const result = await runJson<{ passed: boolean }>(project.workspace.root, "accept");
    if (blocked) {
      expect(result.envelope).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
      return { passed: false };
    }
    expect(result.envelope.ok).toBe(true);
    return result.envelope.data;
  }
  type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
  const handlers = new Map<string, Handler>();
  registerEvidenceTools(
    {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer,
    project.workspace.root,
  );
  const handler = handlers.get("visp_accept");
  if (!handler) throw new Error("Missing accept tool");
  const response = await handler({ detail: true });
  if (blocked) {
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    return { passed: false };
  }
  expect(response.isError).not.toBe(true);
  return (response.structuredContent as { data: { passed: boolean } }).data;
}

it.each(["service", "cli", "mcp"] as const)(
  "%s acceptance requires separately assessed distinct regression evidence after repair",
  async (transport) => {
    const project = await productWorkspace();
    projects.push(project);
    const state = () => project.workspace.state();
    await project.workspace.write(
      "test/adjacent.test.mjs",
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('consumer arithmetic',()=>assert.equal(value+1,3));\n",
    );
    value(
      await updateProductBrief(await state(), {
        brief: {
          ...project.brief,
          checks: [
            ...project.brief.checks.map((check) => ({
              ...check,
              verifierFiles: ["test/value.test.mjs"],
            })),
            {
              id: "C002",
              command: [process.execPath, "--test", "test/adjacent.test.mjs"],
              outcomes: ["O001"],
              files: ["src/value.mjs", "test/adjacent.test.mjs"],
              verifierFiles: ["test/adjacent.test.mjs"],
              environment: "node",
            },
          ],
          slices: project.brief.slices.map((slice) => ({
            ...slice,
            checks: ["C001", "C002"],
            scope: { ...slice.scope, allowed: [...slice.scope.allowed, "test/adjacent.test.mjs"] },
          })),
        },
        reason: "Identify repair and distinct consumer assertions before execution",
      }),
    );
    value(await runProductWork(await state()));
    const failed = value(await runProductVerify(await state())).executions.find(
      (e) => e.check === "C001",
    );
    expect(failed?.status).toBe("failed");
    if (!failed) throw new Error("Missing real failed assertion");
    value(
      await runProductReview(await state(), {
        task: "T001",
        subjectDigest: failed.subjectDigest,
        reviewer: { context: "current" },
        assessments: [],
        feedback: {
          phase: "product",
          dimensions: [],
          resolutions: [],
          findings: [
            {
              dimension: "functional",
              problem: "The public value is one instead of two",
              nextCheck: "Repair the public value and check consumer arithmetic",
              outcomes: ["O001"],
              required: true,
              evidence: [failed.id],
            },
          ],
        },
      }),
    );
    const original = value(await readProductRecord(await state()));
    const finding = outstandingFeedback(original)[0];
    if (!finding) throw new Error("Missing original finding");
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    const repaired = value(await runProductVerify(await state()));
    expect(repaired.passed).toBe(true);
    const repair = repaired.executions.find((e) => e.check === "C001");
    const adjacent = repaired.executions.find((e) => e.check === "C002");
    if (!repair || !adjacent) throw new Error("Missing repaired executions");
    expect(repair.subjectDigest).toBe(adjacent.subjectDigest);
    expect(repair.command).not.toBe(adjacent.command);
    expect(await acceptance(project, transport)).toMatchObject({ passed: false });
    for (const regression of [
      undefined,
      {
        kind: "checked" as const,
        explanation: "Reusing the repair is not adjacent coverage",
        evidence: [repair.id],
      },
    ]) {
      const bundle = value(await runProductReview(await state(), { task: "T001" }));
      const feedback = moduleFeedback(bundle);
      feedback.resolutions = [
        {
          id: finding.id,
          explanation: "The original assertion now passes",
          evidence: [repair.id],
          regression,
        },
      ];
      value(
        await runProductReview(await state(), {
          task: "T001",
          subjectDigest: bundle.subjectDigest,
          reviewer: { context: "current" },
          feedback,
          assessments: [],
        }),
      );
      expect(
        outstandingFeedback(value(await readProductRecord(await state()))).map((f) => f.id),
      ).toContain(finding.id);
      expect(value(await runProductDone(await state())).closed).toBe(false);
      const next = value(await runProductNext(await state(), { task: "T001" }));
      expect(next).toMatchObject({ action: "refine", completion: "unresolved-product" });
      expect(next.command).toContain("review --handoff");
      const routed = await runJson(project.workspace.root, "next", "--task", "T001");
      expect(routed.envelope.data).toEqual(next);
      expect(await acceptance(project, transport)).toMatchObject({ passed: false });
    }
    const bundle = value(await runProductReview(await state(), { task: "T001" }));
    const feedback = moduleFeedback(bundle);
    feedback.resolutions = [
      {
        id: finding.id,
        explanation: "The exact failed assertion passes after changing the implementation",
        evidence: [repair.id],
        regression: {
          kind: "checked",
          explanation:
            "The distinct consumer arithmetic assertion also passes on this repaired implementation",
          evidence: [adjacent.id],
        },
      },
    ];
    value(
      await runProductReview(await state(), {
        task: "T001",
        subjectDigest: bundle.subjectDigest,
        reviewer: { context: "current" },
        feedback,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "Both public value and its consumer pass",
            evidence: [repair.id, adjacent.id],
          },
        ],
      }),
    );
    expect(outstandingFeedback(value(await readProductRecord(await state())))).toEqual([]);
    expect(value(await runProductDone(await state())).closed).toBe(true);
    const final = value(await runProductReview(await state()));
    value(
      await runProductReview(await state(), {
        subjectDigest: final.subjectDigest,
        reviewer: { context: "current" },
        feedback: moduleFeedback(final),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The assembled public module passes its promised behavior",
            evidence: ["C001", "C002"],
          },
        ],
      }),
    );
    expect(await acceptance(project, transport, false)).toMatchObject({ passed: true });
    const after = value(await readProductRecord(await state()));
    expect(after.state.executions).toContainEqual(failed);
    expect(after.state.reviews).toContainEqual(original.state.reviews.at(-1));
  },
);
