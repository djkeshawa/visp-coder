import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { ok } from "../../../../src/core/result.js";
import { runtimeIdentity } from "../../../../src/core/version.js";
import { runChecks } from "../../../../src/doctor/checks.js";
import { createServer } from "../../../../src/mcp/server.js";
import { collectMigrationHistory } from "../../../../src/migration/history-export.js";
import { previewMigration } from "../../../../src/migration/operations.js";
import { runProductCapture } from "../../../../src/workflow/evidence/product-capture.js";
import { runProductControl } from "../../../../src/workflow/evidence/product-control.js";
import {
  createProductFeature,
  updateProductBrief,
} from "../../../../src/workflow/product/brief.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  runProductAccept,
  runProductDone,
  runProductVerify,
} from "../../../../src/workflow/product/evidence.js";
import { runProductReproduction } from "../../../../src/workflow/product/reproduction.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { prepareReviewSession } from "../../../../src/workflow/product/review-session.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductUserFeedback } from "../../../../src/workflow/product/user-feedback.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
async function fixture() {
  const p = await productWorkspace();
  projects.push(p);
  const workspace = await p.workspace.state();
  const installation = JSON.parse(await readFile(workspace.paths.installState, "utf8"));
  return { p, workspace, installation };
}
it("records the build that generated installation assets", async () => {
  const f = await fixture();
  expect(f.installation.runtime).toEqual(runtimeIdentity());
});
it.each([
  "feature",
  "brief",
  "work",
  "verify",
  "done",
  "accept",
  "review",
  "session",
  "reproduce",
  "critic-policy",
  "critic-prepare",
  "capture",
  "control",
  "user-feedback",
])("refuses %s before product state changes under a different installed build", async (action) => {
  const f = await fixture();
  f.installation.runtime = { ...runtimeIdentity(), buildId: "0123456789abcdef" };
  await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
  const before = await collectMigrationHistory(f.p.workspace.root);
  const operations = {
    feature: () => createProductFeature(f.workspace, { goal: "Other feature", branch: false }),
    brief: () => updateProductBrief(f.workspace, { brief: f.p.brief, reason: "Refresh" }),
    work: () => runProductWork(f.workspace, { task: "T001" }),
    verify: () => runProductVerify(f.workspace),
    done: () => runProductDone(f.workspace, { task: "T001" }),
    accept: () => runProductAccept(f.workspace),
    review: () => runProductReview(f.workspace, { assessments: [] }),
    session: () => prepareReviewSession(f.workspace, {}),
    reproduce: () =>
      runProductReproduction(f.workspace, {
        finding: "FB-missing",
        execution: "missing",
        explanation: "Reproduction",
      }),
    "critic-policy": () =>
      runProductCritic(f.workspace, { operation: "set-policy", enabled: false }),
    "critic-prepare": () => runProductCritic(f.workspace, { operation: "prepare", task: "T001" }),
    control: () =>
      runProductControl(f.workspace, {
        experiment: {
          outcomes: ["O001"],
          baseline: { directory: "baseline", files: ["value.js"] },
          changed: { directory: "changed", files: ["value.js"] },
          loadCommand: ["node", "--check"],
          verifierFile: "check.js",
        },
      }),
    "user-feedback": () =>
      runProductUserFeedback(f.workspace, { operation: "ask", question: "Does this work?" }),
    capture: () =>
      runProductCapture(f.workspace, { journey: { url: "http://localhost:1", actions: [] } }),
  };
  expect(await operations[action as keyof typeof operations]()).toMatchObject({
    ok: false,
    error: { code: "RUNTIME_MISMATCH" },
  });
  expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
});
it("keeps review inspection, critic status and migration preview available during runtime drift", async () => {
  const f = await fixture();
  f.installation.runtime = { ...runtimeIdentity(), buildId: "0123456789abcdef" };
  await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
  expect(await runProductReview(f.workspace)).toMatchObject({ ok: true });
  expect(await runProductCritic(f.workspace, { operation: "status" })).toMatchObject({ ok: true });
  expect(await previewMigration(f.p.workspace.root)).toMatchObject({ ok: true });
});
it("requires refreshing a legacy installation without recorded runtime provenance", async () => {
  const f = await fixture();
  delete f.installation.runtime;
  await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
  expect(await runProductVerify(f.workspace)).toMatchObject({
    ok: false,
    error: { code: "RUNTIME_MISMATCH", recovery: expect.stringContaining("install") },
  });
});

it("doctor identifies the installed build that blocks mutation", async () => {
  const f = await fixture();
  f.installation.runtime = { ...runtimeIdentity(), buildId: "0123456789abcdef" };
  await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
  const report = await runChecks(f.workspace, { guardHandshake: async () => ok(undefined) });
  expect(report.checks).toContainEqual(
    expect.objectContaining({
      name: "installed runtime",
      status: "fail",
      detail: expect.stringContaining("0123456789abcdef"),
    }),
  );
});

it("preserves the spent reservation and refuses a critic result after installation changes", async () => {
  const f = await fixture();
  expect((await runProductWork(f.workspace, { task: "T001" })).ok).toBe(true);
  await f.p.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(f.workspace, { task: "T001" })).ok).toBe(true);
  expect(
    (
      await runProductCritic(f.workspace, {
        operation: "set-policy",
        enabled: true,
        harness: "codex",
      })
    ).ok,
  ).toBe(true);
  const before = await readProductRecord(f.workspace);
  const review = vi.fn(async () => {
    f.installation.runtime = { ...runtimeIdentity(), buildId: "0123456789abcdef" };
    await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
    return { model: "gpt-5.6-sol", response: {} };
  });
  const response = await runProductCritic(
    f.workspace,
    { operation: "review", task: "T001" },
    {
      inspect: async () => ({
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      }),
      review,
    },
  );
  expect(review).toHaveBeenCalledTimes(1);
  expect(response).toMatchObject({ ok: false, error: { code: "RUNTIME_MISMATCH" } });
  const after = await readProductRecord(f.workspace);
  expect(after.ok && after.value.state.reviews).toEqual(
    before.ok ? before.value.state.reviews : undefined,
  );
  expect(await runProductCritic(f.workspace, { operation: "status", task: "T001" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1 },
  });
});

it("refuses local CLI and MCP edit authority when the installed build changes", async () => {
  const f = await fixture();
  expect((await runProductWork(f.workspace, { task: "T001" })).ok).toBe(true);
  f.installation.runtime = { ...runtimeIdentity(), buildId: "0123456789abcdef" };
  await writeFile(f.workspace.paths.installState, JSON.stringify(f.installation));
  const cli = await runJson(f.p.workspace.root, "guard", "--path", "src/value.mjs");
  expect(cli.envelope).toMatchObject({ ok: false, error: { code: "RUNTIME_MISMATCH" } });
  const server = createServer(f.p.workspace.root);
  const client = new Client({ name: "guard-runtime", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const response = await client.callTool({
      name: "visp_guard",
      arguments: { paths: ["src/value.mjs"] },
    });
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "RUNTIME_MISMATCH" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
