import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok } from "../../../../src/core/result.js";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import * as criticPolicy from "../../../../src/workflow/product/critic-policy.js";
import {
  backgroundReview,
  inlineReview,
  runProductAcceptReviewed,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = { model: "test-critic", maxCalls: 3, timeoutMs: 5000, maxImageBytes: 4194304 };
let setup: Awaited<ReturnType<typeof productWorkspace>>;

function review(status: "satisfied" | "failed") {
  return (packet: CriticPacket) => ({
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((outcome) => ({
        outcome: outcome.id,
        status,
        summary:
          status === "satisfied"
            ? "Executed the module and observed the promised value"
            : "The module returns three, not the promised two",
        evidence: packet.current.evidence
          .filter((entry) => entry.kind === "execution")
          .slice(0, 1)
          .map((entry) => entry.id),
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  });
}

function launcher(respond: (packet: CriticPacket) => unknown): ProductCriticHost {
  return { review: vi.fn(async (packet) => ({ model: config.model, response: respond(packet) })) };
}

beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  const state = await setup.workspace.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const configured = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "configure",
    config,
  });
  expect(configured.ok).toBe(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});

it("launches the configured critic once checks pass and returns its verdict", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(host.review).toHaveBeenCalledTimes(1);
  expect(done.value.critic).toMatchObject({ reviewed: true, findings: [] });
});

it("turns critic findings into the next repair step", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(launcher(review("failed"))),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.reviewed).toBe(true);
  expect(done.value.next?.action).toBe("fix");
});

it("reports advisory findings without reopening, repair routing or blocking acceptance", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launcher((packet) => {
    const response = review("satisfied")(packet);
    response.review.feedback.findings = [
      {
        dimension: "functional",
        problem: "Unstated extreme input limit",
        nextCheck: "Consider a huge number",
        outcomes: ["O001"],
        required: false,
        evidence: packet.current.evidence
          .filter((entry) => entry.kind === "execution")
          .slice(0, 1)
          .map((entry) => entry.id),
      },
    ];
    return response;
  });
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.findings).toEqual([expect.objectContaining({ required: false })]);
  expect(done.value.next?.action).not.toBe("fix");
  const accepted = await runProductAcceptReviewed(
    await setup.workspace.state(),
    {},
    inlineReview(host),
  );
  expect(accepted.ok && accepted.value.passed, JSON.stringify(accepted)).toBe(true);
  const saved = await readProductRecord(await setup.workspace.state(), {});
  expect(saved.ok && saved.value.state.slices.T001?.status).toBe("closed");
});

it("does not launch the critic while checks fail", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok).toBe(true);
  expect(host.review).not.toHaveBeenCalled();
  if (done.ok) expect(done.value.critic).toBeUndefined();
});

it("reports a background review that finishes before it is ever pending", async () => {
  const cli = join(setup.workspace.root, ".visp", "fake-cli.mjs");
  await writeFile(
    cli,
    `process.stdout.write(JSON.stringify({ ok: true, data: { lifecycle: { acceptedReview: true }, findings: [{ problem: "Wrong status", nextCheck: "GET /x", required: true }] } }));\n`,
  );
  const summary = await backgroundReview(cli, 5000)(await setup.workspace.state(), {
    feature: setup.brief.feature,
  });
  expect(summary).toMatchObject({
    reviewed: true,
    findings: [{ problem: "Wrong status", nextCheck: "GET /x", required: true }],
  });
  // The process log lives in the feature directory, not in a per-review temp directory.
  const log = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "review-process.log",
  );
  expect(JSON.parse(await readFile(log, "utf8"))).toMatchObject({ ok: true });
  if (process.platform !== "win32") expect((await stat(log)).mode & 0o777).toBe(0o600);
});

it("waits for a running review and reports its recorded state instead of a wait step", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const running = async () => ({ reviewed: false, running: true, findings: [] });
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    running,
    1000,
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.running).toBeUndefined();
  expect(done.value.next?.action).not.toBe("wait");
});

it("launches the critic when done closes on checks that already passed under verify", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  const host = launcher(review("satisfied"));
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(host),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(host.review).toHaveBeenCalledTimes(1);
});

it("passes the whole-call deadline and cancellation to review startup", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const controller = new AbortController();
  const deadline = Date.now() + 60;
  vi.spyOn(criticPolicy, "hasPendingCriticReview").mockResolvedValue(ok(true));
  const started = Date.now();
  const starter = vi.fn(async () => ({ reviewed: false, running: true, findings: [] }));
  await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001", deadline, signal: controller.signal },
    starter,
    60_000,
  );
  // The startup wait is 60 s; returning within 30 s means the call deadline ended it.
  expect(Date.now() - started).toBeLessThan(30_000);
  expect(starter).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ deadline, signal: controller.signal }),
  );
});

it("does not execute acceptance checks twice after an inline review", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launcher(review("satisfied"));
  await runProductDone(await setup.workspace.state());
  const progress: string[] = [];
  await runProductAcceptReviewed(
    await setup.workspace.state(),
    {
      onProgress: (event) => {
        if (event.status === "running") progress.push(event.check);
      },
    },
    inlineReview(host),
  );
  expect(progress.filter((check) => check === "C001")).toHaveLength(1);
});

async function callsUsed() {
  const status = await runProductCritic(await setup.workspace.state(), {
    task: "T001",
    operation: "status",
  });
  return status.ok ? (status.value as { callsUsed?: number }).callsUsed : undefined;
}

it("lets an inline review outlast the command's wait budget", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const respond = review("satisfied");
  const slow: ProductCriticHost = {
    review: vi.fn(async (packet) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { model: config.model, response: respond(packet) };
    }),
  };
  // The wait budget ends long before the reviewer answers; the review still completes.
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001", deadline: Date.now() + 200 },
    inlineReview(slow),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  expect(done.ok && done.value.critic).toMatchObject({ reviewed: true });
  expect(slow.review).toHaveBeenCalledTimes(1);
  expect(await callsUsed()).toBe(1);
});

it("starts a review without a deadline, and accept never skips one", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const host = launcher(review("satisfied"));
  await runProductDone(await setup.workspace.state());
  const accepted = await runProductAcceptReviewed(
    await setup.workspace.state(),
    { deadline: Date.now() + 10_000 },
    inlineReview(host),
  );
  expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  // Accept re-runs every check, so "run it again" is no cheaper: it starts the reviewer.
  expect(host.review).toHaveBeenCalledTimes(1);
  const direct = await inlineReview(launcher(review("satisfied")))(await setup.workspace.state(), {
    feature: setup.brief.feature,
    task: "T001",
  });
  expect(direct.reason ?? "").not.toContain("was not started");
});

it("shows why a review attempt ended when the reviewer fails, not a bare 'did not review'", async () => {
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const crashed: ProductCriticHost = {
    review: vi.fn(async () => {
      throw new Error("codex exec crashed before it answered");
    }),
  };
  const done = await runProductDoneReviewed(
    await setup.workspace.state(),
    { task: "T001" },
    inlineReview(crashed),
  );
  expect(done.ok, JSON.stringify(done)).toBe(true);
  if (!done.ok) return;
  expect(done.value.critic?.reviewed).toBe(false);
  expect(done.value.critic?.reason).toContain("codex exec crashed before it answered");
  expect(done.value.critic?.reason).not.toBe("The critic did not review");
});
