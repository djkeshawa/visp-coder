import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductAccept, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { outstandingFeedback } from "../../../../src/workflow/product/findings.js";
import type { IndependentReview } from "../../../../src/workflow/product/independent-review.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import { runProductReproduction } from "../../../../src/workflow/product/reproduction.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
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
  expect(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        checks: setup.brief.checks.map((check) => ({
          ...check,
          verifierFiles: ["test/value.test.mjs"],
        })),
      },
      reason: "Identify the executed verifier",
    }),
  ).toMatchObject({ ok: true });
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

function resolvedAnswer(packet: CriticPacket): IndependentReview {
  const response = answer(packet);
  response.resolutions = (packet.openFindings ?? []).map((finding) => ({
    id: finding.id,
    disposition: "repaired",
    explanation: "Rechecked the source and current execution: the value now equals two",
    evidence: response.assessments[0]?.evidence ?? [],
    regression: { kind: "not-applicable", explanation: "This module exposes one constant" },
  }));
  return response;
}

it("reviews open required findings again when outcomes are satisfied and no new checks run", async () => {
  await reportDefects();
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  let calls = 0;
  const host = launchedHost((packet) => {
    calls += 1;
    return calls === 1
      ? { ...answer(packet), summary: "Both reported problems are repaired; no current defects" }
      : resolvedAnswer(packet);
  });
  expect(await done(host)).toMatchObject({
    ok: true,
    value: { passed: false, closed: false, critic: { reviewed: true } },
  });
  const before = await readProductRecord(await setup.workspace.state());
  if (!before.ok) throw new Error(before.error.message);
  expect(outstandingFeedback(before.value)).toHaveLength(2);
  const third = await done(host);
  expect(host.review).toHaveBeenCalledTimes(2);
  expect(third).toMatchObject({
    ok: true,
    value: { passed: true, closed: true, executions: [], critic: { reviewed: true } },
  });
  const after = await readProductRecord(await setup.workspace.state());
  if (!after.ok) throw new Error(after.error.message);
  expect(after.value.state.executions).toHaveLength(before.value.state.executions.length);
  expect(outstandingFeedback(after.value)).toEqual([]);
});

it.each(["still-open", "not-reproducible"] as const)(
  "retains every required finding for a structured %s disposition and obeys the call budget",
  async (disposition) => {
    await reportDefects();
    const record = await readProductRecord(await setup.workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    const first = record.value.state.reviews[0];
    if (!first?.feedback) throw new Error("Missing initial review");
    for (let batch = 0; batch < 2; batch += 1)
      record.value.state.reviews.push({
        ...first,
        feedback: {
          ...first.feedback,
          findings: Array.from({ length: 3 }, (_, index) => ({
            ...first.feedback?.findings[0],
            dimension: "functional" as const,
            problem: `Required defect ${batch * 3 + index}`,
            nextCheck: "Check the public value",
            outcomes: ["O001"],
            required: true,
            evidence: [],
          })),
        },
      });
    expect(
      await saveProductState(await setup.workspace.state(), record.value, record.value.state),
    ).toMatchObject({ ok: true });
    await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
    const host = launchedHost((packet) => {
      expect(packet.openFindings).toHaveLength(8);
      expect(packet.openFindings?.every((finding) => finding.outcomes.includes("O001"))).toBe(true);
      expect(packet.instructions).toContain("still-open");
      expect(packet.instructions).toContain("not-reproducible");
      return {
        ...answer(packet),
        resolutions: (packet.openFindings ?? []).map((finding) => ({
          id: finding.id,
          disposition,
          explanation: "Missing a focused check of this particular report",
          evidence: [],
          regression: null,
        })),
      };
    });
    for (let index = 0; index < 2; index += 1)
      expect(await done(host)).toMatchObject({
        ok: true,
        value: { passed: false, closed: false, critic: { reviewed: true } },
      });
    expect(await done(host)).toMatchObject({
      ok: true,
      value: { passed: false, closed: false, critic: { reviewed: false } },
    });
    expect(host.review).toHaveBeenCalledTimes(2);
    const saved = await readProductRecord(await setup.workspace.state());
    if (!saved.ok) throw new Error(saved.error.message);
    expect(outstandingFeedback(saved.value)).toHaveLength(8);
    expect(saved.value.state.reviews.at(-1)?.feedback?.resolutions).toHaveLength(8);
    expect(saved.value.state.status).toBe("active");
    expect(await runProductAccept(await setup.workspace.state())).toMatchObject({
      ok: true,
      value: { passed: false },
    });
  },
);

it("keeps failing checks blocking an owed finding review", async () => {
  await reportDefects();
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launchedHost(answer);
  expect(await done(host)).toMatchObject({ ok: true, value: { critic: { reviewed: true } } });
  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  await setup.workspace.write(
    "test/value.test.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
  );
  expect(await done(host)).toMatchObject({ ok: true, value: { passed: false, closed: false } });
  expect(host.review).toHaveBeenCalledTimes(1);
});

it("includes a new reproduction attachment in dedupe even with unchanged source and check receipts", async () => {
  await reportDefects();
  await setup.workspace.write(
    "test/value.test.mjs",
    "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
  );
  const checked = await runProductVerify(await setup.workspace.state(), { task: "T001" });
  const loaded = await readProductRecord(await setup.workspace.state());
  if (!checked.ok || !loaded.ok) throw new Error("Missing reproduction");
  const execution = checked.value.executions[0];
  const finding = outstandingFeedback(loaded.value)[0];
  if (!execution || !finding) throw new Error("Missing finding or failed receipt");
  expect(execution.status).toBe("failed");
  // Advice on the failing source cannot resolve findings. It still dedupes unchanged evidence.
  const host = launchedHost((packet) => ({ ...answer(packet), assessments: [] }));
  expect(
    await runProductCritic(
      await setup.workspace.state(),
      { task: "T001", operation: "review", sourceOnly: true },
      host,
    ),
  ).toMatchObject({ ok: true });
  expect(
    await runProductReproduction(await setup.workspace.state(), {
      task: "T001",
      finding: finding.id,
      execution: execution.id,
      explanation: "The executed public value assertion demonstrates this report",
    }),
  ).toMatchObject({ ok: true });
  const second = await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review", sourceOnly: true },
    host,
  );
  expect(second).toMatchObject({ ok: true });
  expect(host.review).toHaveBeenCalledTimes(2);
  const selected = await criticSelection(await setup.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const stored = await readCriticState(await setup.workspace.state(), selected.value);
  if (!stored.ok) throw new Error(stored.error.message);
  const attempts = stored.value.state?.attempts.slice(-2);
  expect(attempts?.[0]?.evidenceDigest).not.toBe(attempts?.[1]?.evidenceDigest);
  expect(attempts?.map((attempt) => attempt.transport)).toEqual(["native", "native"]);
});
