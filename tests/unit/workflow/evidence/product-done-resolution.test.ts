import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { outstandingFeedback } from "../../../../src/workflow/product/findings.js";
import type { IndependentReview } from "../../../../src/workflow/product/independent-review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  harness: "codex" as const,
  transport: "native" as const,
  maxCalls: 3,
  timeoutMs: 5000,
  maxImageBytes: 4194304,
};
let setup: Awaited<ReturnType<typeof productWorkspace>>;

beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: "codex-exec" };
  await setup.workspace.write("visp.yml", stringify(raw));
  setup.workspace.commit("configure launched reviewer");
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
  });
  expect(
    await runProductCritic(await setup.workspace.state(), {
      task: "T001",
      operation: "configure",
      config,
    }),
  ).toMatchObject({ ok: true });
  // A passing but incomplete check lets the reviewer find a real contract defect.
  await setup.workspace.write(
    "test/value.test.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.ok(Number.isFinite(value));\n",
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});

function answer(packet: CriticPacket): IndependentReview {
  const evidence = packet.current.evidence
    .filter((entry) => entry.kind === "execution" && entry.status === "available")
    .map((entry) => entry.id);
  return {
    summary: "Checked the current module and executed value assertion",
    assessments: packet.current.outcomes.map((outcome) => ({
      outcome: outcome.id,
      status: "satisfied",
      summary: "The module returns the promised value",
      evidence,
      expectations: [],
    })),
    findings: [],
    limitations: [],
    resolutions: [],
    disputes: [],
  };
}

function launchedHost(respond: (packet: CriticPacket) => IndependentReview): ProductCriticHost {
  return {
    inspect: async () => ({
      harness: "codex",
      model: config.model,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    }),
    review: vi.fn(async (packet) => ({
      model: config.model,
      context: "fresh" as const,
      response: respond(packet),
    })),
  };
}

async function done(host: ProductCriticHost) {
  return runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
}

async function reportDefects() {
  const host = launchedHost((packet) => {
    const response = answer(packet);
    const assessment = response.assessments[0];
    if (!assessment) throw new Error("Missing assessment");
    assessment.status = "failed";
    response.findings = ["The exported value is one", "The default result is not two"].map(
      (problem) => ({
        problem,
        consequence: "The request's public value contract is violated",
        nextCheck: "Assert that the public value is two",
        evidence: response.assessments[0]?.evidence ?? [],
        outcomes: ["O001"],
        required: true,
      }),
    );
    return response;
  });
  expect(await done(host)).toMatchObject({ ok: true, value: { critic: { reviewed: true } } });
  const saved = await readProductRecord(await setup.workspace.state());
  if (!saved.ok) throw new Error(saved.error.message);
  expect(outstandingFeedback(saved.value)).toHaveLength(2);
}

it("returns closure and findings from the saved structured repair review in the same done call", async () => {
  await reportDefects();
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launchedHost((packet) => {
    const response = answer(packet);
    response.resolutions = (packet.openFindings ?? []).map((finding) => ({
      id: finding.id,
      disposition: "repaired",
      explanation: "Rechecked the source: the exported value now equals two",
      evidence: response.assessments[0]?.evidence ?? [],
      regression: { kind: "not-applicable", explanation: "This module exposes one constant" },
    }));
    return response;
  });
  const result = await done(host);
  const saved = await readProductRecord(await setup.workspace.state());
  if (!saved.ok) throw new Error(saved.error.message);
  expect(outstandingFeedback(saved.value)).toEqual([]);
  expect(saved.value.state.reviews.at(-1)?.feedback?.resolutions).toHaveLength(2);
  expect(result).toMatchObject({
    ok: true,
    value: { passed: true, closed: true, gaps: [], feedbackPlan: { findings: [] } },
  });
  expect(saved.value.state.slices.T001?.status).toBe("closed");
  expect(host.review).toHaveBeenCalledTimes(1);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.executions).toHaveLength(1);
  expect(saved.value.state.executions).toHaveLength(2);
});
