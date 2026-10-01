import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it } from "vitest";
import { hashValue } from "../../../src/core/hash.js";
import { registerCaptureTools } from "../../../src/mcp/tools/capture.js";
import { browserJourneySchema } from "../../../src/testing/browser-journey.js";
import { productJourneyKey } from "../../../src/workflow/evidence/product-journey.js";
import { readProductRecord, saveProductState } from "../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../src/workflow/product/subject.js";
import { runJson } from "../../unit/cli/support/cli.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";
import type { TestWorkspace } from "../../unit/support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.destroy()));
});

it.each(["cli", "mcp"])(
  "records retirement via %s and delivers the unchanged failure and reason to review",
  async (adapter) => {
    const { workspace, brief } = await productWorkspace();
    workspaces.push(workspace);
    const state = await workspace.state();
    const record = await readProductRecord(state, { feature: brief.feature });
    if (!record.ok) throw new Error(record.error.message);
    const subject = await productSourceDigest(state, brief);
    if (!subject.ok) throw new Error(subject.error.message);
    const journey = browserJourneySchema.parse({
      url: "http://localhost:3000/",
      actions: [{ kind: "click", selector: "#aim" }],
    });
    const run = {
      id: "CAPRUN-exploration",
      version: 2,
      provenance: "runner-executed",
      task: "T001",
      subjectDigest: subject.value,
      contractDigest: productContractDigest(brief, brief.slices[0]),
      journey,
      journeyDigest: hashValue(journey),
      journeyKey: productJourneyKey(journey, "T001"),
      expectation: { basis: "agent-proposed", outcomes: [] },
      status: "timed-out",
      failure: { kind: "behavior", message: "Speculative win did not occur" },
      captures: [],
      operations: [],
    };
    const saved = await saveProductState(state, record.value, {
      ...record.value.state,
      captureRuns: [run],
    });
    if (!saved.ok) throw new Error(saved.error.message);
    const reason = "This aim can legitimately miss";
    if (adapter === "cli") {
      const reply = await runJson(
        workspace.root,
        "capture",
        "--feature",
        brief.feature,
        "--retire",
        run.id,
        "--reason",
        reason,
      );
      expect(reply.envelope).toMatchObject({
        ok: true,
        data: { retirement: { runId: run.id, reason }, originalStatus: "timed-out" },
      });
    } else {
      let handler:
        | ((args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>)
        | undefined;
      registerCaptureTools(
        {
          registerTool(_name: string, _config: unknown, callback: typeof handler) {
            handler = callback;
          },
        } as unknown as McpServer,
        workspace.root,
      );
      if (!handler) throw new Error("Missing capture handler");
      const reply = await handler({ feature: brief.feature, retire: run.id, reason }, {});
      expect(reply.structuredContent).toMatchObject({
        ok: true,
        data: { retirement: { runId: run.id, reason }, originalStatus: "timed-out" },
      });
      expect(reply.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: expect.stringContaining(reason) }),
        ]),
      );
    }
    const review = await runJson(
      workspace.root,
      "review",
      "--feature",
      brief.feature,
      "--task",
      "T001",
    );
    expect(review.envelope).toMatchObject({
      ok: true,
      data: {
        experiments: {
          exploratory: [{ runId: run.id, status: "timed-out", retirement: { reason } }],
        },
      },
    });
    const after = await readProductRecord(state, { feature: brief.feature });
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.state.captureRuns).toEqual([run]);
  },
);
