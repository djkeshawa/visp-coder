import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import { createServer } from "../../../../src/mcp/server.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { outstandingFeedback } from "../../../../src/workflow/product/findings.js";
import { findFunctionalRepair } from "../../../../src/workflow/product/functional-resolution.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { runProductReproduction } from "../../../../src/workflow/product/reproduction.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import {
  independentReviewerContext,
  runProductReviewerHandoff,
} from "../../../../src/workflow/product/reviewer-handoff.js";
import {
  type ProductRecord,
  readProductRecord,
  saveProductState,
} from "../../../../src/workflow/product/store.js";
import {
  productContractDigest,
  productSourceDigest,
} from "../../../../src/workflow/product/subject.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { runJson } from "../../cli/support/cli.js";
import { productWorkspace } from "../../support/product-workspace.js";

const connections: (() => Promise<void>)[] = [];
const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  for (const close of connections.splice(0)) await close();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});

it.each(["service", "service-collision", "cli", "minimal", "standard"] as const)(
  "persists a later failure through %s without rewriting the report",
  async (transport) => {
    const p = await productWorkspace();
    projects.push(p);
    const state = await p.workspace.state();
    const client =
      transport === "minimal" || transport === "standard"
        ? new Client({ name: "reproduction-test", version: "1" })
        : undefined;
    if (client && (transport === "minimal" || transport === "standard")) {
      const server = createServer(p.workspace.root, transport);
      const [a, b] = InMemoryTransport.createLinkedPair();
      connections.push(async () => {
        await client.close();
        await server.close();
      });
      await server.connect(a);
      await client.connect(b);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("visp_reproduce");
    }
    async function attach(
      workspace: WorkspaceState,
      request: { finding: string; execution?: string; task: string; explanation: string },
    ) {
      if (transport === "service" || transport === "service-collision")
        return runProductReproduction(workspace, request);
      const envelope = client
        ? (await client.callTool({ name: "visp_reproduce", arguments: request })).structuredContent
        : (
            await runJson(
              p.workspace.root,
              "reproduce",
              "--finding",
              request.finding,
              "--execution",
              request.execution ?? "missing",
              "--task",
              request.task,
              "--reason",
              request.explanation,
            )
          ).envelope;
      const result = envelope as { ok: boolean; data?: unknown; error?: unknown };
      return result.ok ? { ok: true, value: result.data } : { ok: false, error: result.error };
    }
    const updated = await updateProductBrief(state, {
      brief: {
        ...p.brief,
        checks: p.brief.checks.map((check) => ({
          ...check,
          verifierFiles: ["test/value.test.mjs"],
        })),
      },
      reason: "Bind the executed verifier",
    });
    expect(updated.ok).toBe(true);
    expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
    const loaded = await readProductRecord(state);
    const subject = await productSourceDigest(state);
    if (!loaded.ok || !subject.ok) throw new Error("fixture unavailable");
    const review = {
      subjectDigest: subject.value,
      task: "T001",
      contractDigest: productContractDigest(loaded.value.brief, loaded.value.brief.slices[0]),
      createdAt: new Date().toISOString(),
      assessments: [],
      captures: [],
      feedback: {
        phase: "product" as const,
        dimensions: [],
        resolutions: [],
        findings: [
          {
            dimension: "functional" as const,
            problem: "Value is incorrect",
            nextCheck: "Execute the value assertion",
            required: true,
            evidence: [],
            outcomes: ["O001"],
          },
        ],
      },
    };
    loaded.value.state.reviews.push(review);
    expect((await saveProductState(state, loaded.value, loaded.value.state)).ok).toBe(true);
    let finding = outstandingFeedback(loaded.value)[0];
    if (!finding) throw new Error("finding missing");
    await p.workspace.write(
      "test/value.test.mjs",
      "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
    );
    const verified = await runProductVerify(state, { task: "T001" });
    if (!verified.ok) throw new Error(verified.error.message);
    const execution = verified.value.executions[0];
    expect(execution?.status).toBe("failed");
    expect(execution?.subjectDigest).not.toBe(subject.value);
    const input = {
      finding: finding.id,
      execution: execution?.id,
      task: "T001",
      explanation: "The public value assertion reproduces the report",
    };
    expect(await attach(state, { ...input, execution: "missing" })).toMatchObject({
      ok: false,
    });
    const priorPacket = await runProductReview(state, { task: "T001" });
    if (!priorPacket.ok) throw new Error(priorPacket.error.message);
    const attached = await attach(state, input);
    expect(attached).toMatchObject({ ok: true });
    expect(
      await runProductReview(state, { task: "T001", selection: priorPacket.value.selection }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    expect(await attach(await p.workspace.state(), input)).toEqual(attached);
    const stored = await readProductRecord(await p.workspace.state());
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.state.reproductions).toHaveLength(1);
    expect(stored.value.state.reviews).toEqual([review]);
    expect(outstandingFeedback(stored.value)).toHaveLength(1);
    async function recoverHistoricalCollision(record: ProductRecord) {
      record.state.reviews.push({ ...review, task: "T002" });
      expect((await saveProductState(state, record, record.state)).ok).toBe(true);
      finding = outstandingFeedback(record).find((entry) => entry.task === "T001");
      if (!finding) throw new Error("Recovered owner missing");
      input.finding = finding.id;
      expect(await attach(await p.workspace.state(), input)).toEqual(attached);
      const repeated = await readProductRecord(await p.workspace.state());
      if (!repeated.ok) throw new Error(repeated.error.message);
      expect(repeated.value.state.reproductions).toHaveLength(1);
    }
    if (transport === "service-collision") await recoverHistoricalCollision(stored.value);
    await p.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(await attach(await p.workspace.state(), input)).toMatchObject({
      ok: false,
    });
    const repaired = await runProductVerify(await p.workspace.state(), { task: "T001" });
    const after = await readProductRecord(await p.workspace.state());
    if (!repaired.ok || !after.ok) throw new Error("Recheck unavailable");
    expect(
      findFunctionalRepair(
        after.value,
        finding,
        repaired.value.executions.map((entry) => entry.id),
      ),
    ).toMatchObject({ reproductionId: execution?.id, subjectDigest: repaired.value.subjectDigest });
    const handoff = await runProductReviewerHandoff(await p.workspace.state(), { task: "T001" });
    if (!handoff.ok) throw new Error(handoff.error.message);
    expect(independentReviewerContext(handoff.value)).toMatchObject({
      repairQuestions: [
        {
          id: finding.id,
          reproductions: [
            {
              execution: execution?.id,
              subjectDigest: execution?.subjectDigest,
              provenance: "caller-reported",
            },
          ],
        },
      ],
    });
  },
);

const refusedAttachments: {
  name: string;
  status?: "accepted" | "historical-complete";
  dimension?: "non-functional";
  patch?: Record<string, string>;
  code?: string;
}[] = [
  { name: "malformed request", patch: { explanation: " " }, code: "ARTIFACT_INVALID" },
  { name: "unknown feature", patch: { feature: "999-missing" } },
  { name: "accepted feature", status: "accepted", code: "STAGE_BLOCKED" },
  { name: "historical feature", status: "historical-complete", code: "STAGE_BLOCKED" },
  { name: "missing finding", patch: { finding: "FB-missing" }, code: "ARTIFACT_INVALID" },
  { name: "wrong slice", patch: { task: "T002" }, code: "ARTIFACT_INVALID" },
  { name: "non-functional", dimension: "non-functional", code: "ARTIFACT_INVALID" },
];
it.each(refusedAttachments)(
  "rejects $name reproduction attachment without changing evidence",
  async (testCase) => {
    const p = await productWorkspace();
    projects.push(p);
    const workspace = await p.workspace.state();
    const loaded = await readProductRecord(workspace);
    const subject = await productSourceDigest(workspace);
    if (!loaded.ok || !subject.ok) throw new Error("Fixture unavailable");
    const record = loaded.value;
    record.state.reviews.push({
      subjectDigest: subject.value,
      task: "T001",
      contractDigest: productContractDigest(record.brief, record.brief.slices[0]),
      createdAt: new Date().toISOString(),
      assessments: [],
      captures: [],
      feedback: {
        phase: "product",
        dimensions: [],
        resolutions: [],
        findings: [
          {
            dimension: testCase.dimension ?? "functional",
            problem: "The reported result needs investigation",
            nextCheck: "Execute the public assertion",
            required: true,
            evidence: [],
            outcomes: ["O001"],
          },
        ],
      },
    });
    if (testCase.status) record.state.status = testCase.status;
    const saved = await saveProductState(workspace, record, record.state);
    if (!saved.ok) throw new Error(saved.error.message);
    const before = await readProductRecord(workspace);
    if (!before.ok) throw new Error(before.error.message);
    const finding = outstandingFeedback(before.value)[0];
    if (!finding) throw new Error("Finding missing");
    const result = await runProductReproduction(workspace, {
      feature: record.brief.feature,
      task: "T001",
      finding: finding.id,
      execution: "EXEC-missing",
      explanation: "Caller claims this reproduces the issue",
      ...testCase.patch,
    });
    expect(result.ok).toBe(false);
    if (testCase.code) expect(result).toMatchObject({ error: { code: testCase.code } });
    const after = await readProductRecord(workspace);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.stateText).toBe(before.value.stateText);
    expect(after.value.state.reproductions ?? []).toEqual([]);
  },
);

it("retains the reviewed subject while a prepared critic review is pending", async () => {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  const workspace = await p.workspace.state();
  const config = balancedCritic("codex");
  if (!config) throw new Error("Missing critic preset");
  expect(
    await runProductCritic(workspace, { operation: "configure", task: "T001", config }),
  ).toMatchObject({ ok: true });
  expect(
    await runProductCritic(workspace, {
      operation: "prepare",
      task: "T001",
      sourceOnly: true,
      capabilities: {
        harness: "codex",
        model: config.model,
        reasoningEffort: "high",
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      },
    }),
  ).toMatchObject({ ok: true });
  const before = await readProductRecord(workspace);
  if (!before.ok) throw new Error(before.error.message);
  expect(
    await runProductReproduction(workspace, {
      task: "T001",
      finding: "FB-pending",
      execution: "EXEC-pending",
      explanation: "Attempt to add evidence during the pending review",
    }),
  ).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
  const after = await readProductRecord(workspace);
  if (!after.ok) throw new Error(after.error.message);
  expect(after.value.stateText).toBe(before.value.stateText);
});
