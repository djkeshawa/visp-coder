import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { registerEvidenceTools } from "../../../../src/mcp/tools/evidence.js";
import { outstandingFeedback } from "../../../../src/workflow/product/feedback.js";
import {
  runProductAccept,
  runProductDone,
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

async function acceptance(project: Project, transport: "service" | "cli" | "mcp") {
  if (transport === "service")
    return value(await runProductAccept(await project.workspace.state()));
  if (transport === "cli") {
    const result = await runJson<{ passed: boolean }>(project.workspace.root, "accept");
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
  expect(response.isError).not.toBe(true);
  return (response.structuredContent as { data: { passed: boolean } }).data;
}

it.each(["service", "cli", "mcp"] as const)(
  "%s acceptance requires assessed executed disproof and preserves the original finding",
  async (transport) => {
    const project = await productWorkspace();
    projects.push(project);
    const state = () => project.workspace.state();
    value(
      await updateProductBrief(await state(), {
        brief: {
          ...project.brief,
          checks: project.brief.checks.map((check) => ({
            ...check,
            verifierFiles: ["test/value.test.mjs"],
          })),
        },
        reason: "Identify the assertion used for functional counterevidence",
      }),
    );
    value(await runProductWork(await state()));
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(value(await runProductDone(await state())).closed).toBe(true);
    const first = value(await runProductReview(await state()));
    const feedback = moduleFeedback(first);
    feedback.findings.push({
      dimension: "functional",
      problem: "The exported value may not equal two",
      nextCheck: "Execute the public value assertion",
      outcomes: ["O001"],
      required: true,
      evidence: [],
    });
    value(
      await runProductReview(await state(), {
        subjectDigest: first.subjectDigest,
        reviewer: { context: "current" },
        feedback,
        assessments: [],
      }),
    );
    const before = value(await readProductRecord(await state()));
    const originalReview = structuredClone(before.state.reviews.at(-1));
    const finding = outstandingFeedback(before)[0];
    if (!finding) throw new Error("Missing reported finding");
    expect(await acceptance(project, transport)).toMatchObject({ passed: false });
    expect(value(await runProductVerify(await state())).passed).toBe(true);
    const verified = value(await readProductRecord(await state()));
    expect(verified.state.executions.length).toBeGreaterThan(before.state.executions.length);
    expect(verified.state.executions.at(-1)).toMatchObject({
      provenance: "supervisor-executed",
      status: "passed",
      exitCode: 0,
    });
    expect(await acceptance(project, transport)).toMatchObject({ passed: false });
    expect(outstandingFeedback(value(await readProductRecord(await state())))[0]?.id).toBe(
      finding.id,
    );
    const bundle = value(await runProductReview(await state()));
    const resolution = moduleFeedback(bundle);
    resolution.resolutions = [
      {
        id: finding.id,
        disposition: "disproved",
        explanation:
          "The fresh identified public assertion passed; the claimed wrong value was not observed.",
        evidence: ["C001"],
      },
    ];
    value(
      await runProductReview(await state(), {
        subjectDigest: bundle.subjectDigest,
        reviewer: { context: "current" },
        feedback: resolution,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The public value assertion passes",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(await acceptance(project, transport)).toMatchObject({ passed: true });
    const after = value(await readProductRecord(await state()));
    expect(outstandingFeedback(after)).toEqual([]);
    expect(after.state.reviews).toContainEqual(originalReview);
    expect(after.state.executions.every((execution) => execution.status === "passed")).toBe(true);
  },
);
