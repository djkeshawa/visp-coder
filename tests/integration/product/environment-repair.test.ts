import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import type { Result } from "../../../src/core/result.js";
import { createServer } from "../../../src/mcp/server.js";
import { outstandingFeedback } from "../../../src/workflow/product/feedback.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductStatus,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { runProductReview } from "../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { runJson } from "../../unit/cli/support/cli.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await setup?.workspace.destroy();
});
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function callProduct(
  transport: "service" | "cli" | "mcp",
  command: "done" | "accept" | "next" | "status",
) {
  if (!setup) throw new Error("Missing fixture");
  const workspace = setup.workspace;
  const selection = command === "done" ? { task: "T001" } : {};
  if (transport === "service") {
    const state = await workspace.state();
    const operations = {
      done: () => runProductDone(state, selection),
      accept: () => runProductAccept(state),
      next: () => runProductNext(state),
      status: () => runProductStatus(state),
    };
    const result = await operations[command]();
    return result.ok ? { ok: true, data: result.value } : result;
  }
  if (transport === "cli") {
    const result = await runJson<Record<string, unknown>>(
      workspace.root,
      command,
      ...(command === "done" ? ["--task", "T001"] : []),
    );
    return result.envelope;
  }
  const server = createServer(workspace.root);
  const client = new Client({ name: "environment-closeout-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const result = await client.callTool({ name: `visp_${command}`, arguments: selection });
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}

it.each(["service", "cli", "mcp"] as const)(
  "persists assessed environment repair through %s from actual failed and passed executions",
  async (transport) => {
    setup = await productWorkspace();
    const { workspace, brief } = setup;
    await workspace.write(
      "src/value.mjs",
      "export const value = process.env.VISP_TEST_APP_MODE === 'ready' ? 2 : 1;\n",
    );
    unwrap(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...brief,
          checks: brief.checks.map((check) => ({
            ...check,
            verifierFiles: ["test/value.test.mjs"],
          })),
        },
        reason: "Identify the unchanged behavioral assertion",
      }),
    );
    vi.stubEnv("VISP_TEST_APP_MODE", "broken");
    unwrap(await runProductWork(await workspace.state(), { task: "T001" }));
    const before = unwrap(await runProductVerify(await workspace.state(), { task: "T001" }))
      .executions[0];
    if (!before) throw new Error("Missing failed execution");
    expect(before.status).toBe("failed");
    unwrap(
      await runProductReview(await workspace.state(), {
        task: "T001",
        subjectDigest: before.subjectDigest,
        assessments: [],
        reviewer: { context: "current" },
        feedback: {
          phase: "product",
          dimensions: [],
          resolutions: [],
          findings: [
            {
              dimension: "functional",
              required: true,
              problem: "The application mode returns one instead of two",
              nextCheck: "Correct runtime configuration and rerun the same assertion",
              outcomes: ["O001"],
              evidence: [before.id],
            },
          ],
        },
      }),
    );
    vi.stubEnv("VISP_TEST_APP_MODE", "ready");
    unwrap(await runProductWork(await workspace.state(), { task: "T001" }));
    const after = unwrap(await runProductVerify(await workspace.state(), { task: "T001" }))
      .executions[0];
    if (!after) throw new Error("Missing successful execution");
    expect(after.status).toBe("passed");
    expect(after.verifierDigest).toBe(before.verifierDigest);
    expect(after.comparisonEnvironment).not.toBe(before.comparisonEnvironment);
    const record = unwrap(await readProductRecord(await workspace.state()));
    const finding = outstandingFeedback(record)[0];
    if (!finding) throw new Error("Missing retained finding");
    const packet = unwrap(await runProductReview(await workspace.state(), { task: "T001" }));
    expect(packet.feedbackPlan.findings[0]?.recheck?.environmentRepair).toMatchObject({
      from: before.comparisonEnvironment,
      to: after.comparisonEnvironment,
      requiresAssessment: true,
    });
    for (const command of ["next", "status"] as const) {
      const next = { objective: expect.stringContaining("Assess the observed environment change") };
      expect(await callProduct(transport, command)).toMatchObject({
        ok: true,
        data: command === "next" ? next : { next },
      });
    }
    expect(await callProduct(transport, "done")).toMatchObject({
      ok: true,
      data: { passed: false, closed: false },
    });
    expect(await callProduct(transport, "accept")).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED" },
    });
    const environmentChange = {
      from: before.comparisonEnvironment,
      to: after.comparisonEnvironment,
      explanation:
        "The application mode was corrected to ready; unchanged source and verifier now produce the required value.",
    };
    const submission = {
      task: "T001",
      subjectDigest: after.subjectDigest,
      assessments: [],
      reviewer: { context: "current" },
      feedback: {
        phase: "product",
        dimensions: [],
        findings: [],
        resolutions: [
          {
            id: finding.id,
            environmentChange,
            explanation: "Runtime configuration repaired the observed result",
            evidence: [after.id],
            regression: {
              kind: "not-applicable",
              explanation:
                "This fixture exposes a single mode lookup with no additional operation; the complete promised output is asserted.",
            },
          },
        ],
      },
    };
    if (transport === "service")
      unwrap(await runProductReview(await workspace.state(), submission));
    else if (transport === "cli") {
      const { task: _task, ...authored } = submission;
      await workspace.write(".visp/environment-resolution.json", JSON.stringify(authored));
      const response = await runJson(
        workspace.root,
        "review",
        "--task",
        "T001",
        "--from",
        ".visp/environment-resolution.json",
      );
      expect(response.exitCode, JSON.stringify(response.envelope)).toBe(0);
    } else {
      const server = createServer(workspace.root);
      const client = new Client({ name: "environment-repair-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const response = await client.callTool({ name: "visp_review", arguments: submission });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(await callProduct(transport, "done")).toMatchObject({
      ok: true,
      data: { passed: true, closed: true },
    });
    expect(await callProduct(transport, "accept")).toMatchObject({
      ok: true,
      data: { passed: false, gaps: [expect.stringContaining("final goal assessment unassessed")] },
    });
    const final = unwrap(await runProductReview(await workspace.state()));
    unwrap(
      await runProductReview(await workspace.state(), {
        subjectDigest: final.subjectDigest,
        reviewer: { context: "current" },
        feedback: moduleFeedback(final),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The configured public module returns the promised value",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(await callProduct(transport, "accept")).toMatchObject({
      ok: true,
      data: { passed: true },
    });
    for (const command of ["next", "status"] as const) {
      const next = { action: "complete" };
      expect(await callProduct(transport, command)).toMatchObject({
        ok: true,
        data: command === "next" ? next : { next },
      });
    }
    const saved = unwrap(await readProductRecord(await workspace.state()));
    expect(outstandingFeedback(saved)).toEqual([]);
    expect(saved.state.executions.find((entry) => entry.id === before.id)).toEqual(before);
    expect(
      saved.state.reviews.find((review) =>
        review.feedback?.resolutions.some((resolution) => resolution.id === finding.id),
      )?.feedback?.resolutions[0]?.environmentChange,
    ).toEqual(environmentChange);
  },
);
