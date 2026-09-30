import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import { reviewerCapacity } from "../../../../src/workflow/product/critic-capacity.js";
import { runProductDone, runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { outstandingFeedback } from "../../../../src/workflow/product/feedback.js";
import type { ProductFeedback } from "../../../../src/workflow/product/feedback-model.js";
import { runProductNext } from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  harness: "codex",
  transport: "native",
  maxCalls: 5,
  timeoutMs: 5000,
  maxImageBytes: 4 * 1024 * 1024,
};
const FINDING = "The exported value is not the promised one";

function answer(packet: CriticPacket, finding = false) {
  const feedback: ProductFeedback = moduleFeedback(
    packet.current as unknown as ProductReviewBundle,
  );
  return {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((o) => ({
        outcome: o.id,
        status: finding ? "failed" : "satisfied",
        summary: "Executed the module and observed the value",
        evidence: ["C001"],
        expectations: [],
      })),
      feedback: finding
        ? {
            ...feedback,
            findings: [
              {
                dimension: "functional",
                problem: FINDING,
                nextCheck: "Run the module verifier",
                outcomes: ["O001"],
                required: true,
                evidence: [],
              },
            ],
          }
        : feedback,
    },
    comparison: [],
  };
}

// What codexExecCriticHost is: capabilities come from inspect, so VISP's own attempts are native.
const capabilities = {
  harness: "codex" as const,
  model: config.model,
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};
const attached = (review: ProductCriticHost["review"]): ProductCriticHost => ({
  inspect: async () => capabilities,
  review: async (packet, options) => ({
    context: "fresh" as const,
    ...(await review(packet, options)),
  }),
});
const failing = () =>
  attached(
    vi.fn(async () => {
      throw new Error("codex exec crashed");
    }),
  );
const working = (finding = false) =>
  attached(vi.fn(async (packet) => ({ model: config.model, response: answer(packet, finding) })));

describe("VISP's reviewer capacity", () => {
  let setup: Awaited<ReturnType<typeof productWorkspace>>;
  const run = async (input: object, host?: ProductCriticHost) =>
    runProductCritic(await setup.workspace.state(), { task: "T001", ...input }, host);
  const capacity = async (subject = "current") =>
    reviewerCapacity(await setup.workspace.state(), setup.brief.feature, subject, "T001");
  async function subject() {
    const done = await runProductVerify(await setup.workspace.state(), { task: "T001" });
    if (!done.ok) throw new Error(done.error.message);
    return done.value.subjectDigest;
  }
  async function launch(value: "codex-exec" | undefined) {
    const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
    raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: value };
    await setup.workspace.write("visp.yml", stringify(raw));
    setup.workspace.commit("reviewer launch mode");
  }
  async function ready(limits: object = config) {
    expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    expect((await run({ operation: "configure", config: limits })).ok).toBe(true);
  }
  async function edit(comment: string) {
    await setup.workspace.write("src/value.mjs", `export const value = 2; // ${comment}\n`);
    return subject();
  }

  beforeEach(async () => {
    setup = await productWorkspace({ critic: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await setup.workspace.destroy();
  });

  it("is available whenever VISP does not launch the reviewer, even with nothing left", async () => {
    await launch(undefined);
    await ready({ ...config, maxCalls: 1 });
    await run({ operation: "review" }, working());
    expect(await capacity(await subject())).toEqual({ available: true });
  });

  it("is available before any review, and for a selection with no reviewer configured", async () => {
    await launch("codex-exec");
    expect(await capacity()).toEqual({ available: true });
    await ready();
    expect(await capacity(await subject())).toEqual({ available: true });
  });

  it("is gone when the feature's calls are spent", async () => {
    await launch("codex-exec");
    await ready({ ...config, maxCalls: 1 });
    await run({ operation: "review" }, working());
    expect(await capacity(await subject())).toMatchObject({
      available: false,
      reason: expect.stringContaining("budget is spent"),
    });
  });

  it("is gone when the feature's time budget is spent with calls left", async () => {
    await launch("codex-exec");
    // Each attempt reserves its whole timeout: three of 300 s leave 180 s of 18 min, under one more.
    await ready({ ...config, timeoutMs: 300_000, maxCalls: 5 });
    for (const comment of ["a", "b", "c"]) {
      expect(await run({ operation: "review" }, working())).toMatchObject({ ok: true });
      await edit(comment);
    }
    const now = await capacity(await subject());
    expect(now).toMatchObject({ available: false, reason: expect.stringContaining("budget") });
    const status = await run({ operation: "status" });
    expect(status).toMatchObject({ ok: true, value: { callsUsed: 3, callsRemaining: 2 } });
  });

  it("is gone after two failures on one source, and back when the source changes", async () => {
    await launch("codex-exec");
    await ready();
    const source = await subject();
    await run({ operation: "review" }, failing());
    expect(await capacity(source)).toEqual({ available: true });
    await run({ operation: "review" }, failing());
    expect(await capacity(source)).toMatchObject({
      available: false,
      reason: expect.stringContaining("failed twice"),
    });
    expect(await capacity(await edit("changed"))).toEqual({ available: true });
  });

  it("ignores a failure the worker submitted through prepare and submit", async () => {
    await launch("codex-exec");
    await ready();
    const source = await subject();
    const prepared = await run({ operation: "prepare", capabilities });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const { attempt } = prepared.value as { attempt: string };
    await run({
      operation: "submit",
      result: {
        attempt,
        model: config.model,
        context: "fresh",
        failure: "The host reviewer became unavailable",
      },
    });
    // One call was spent, but a worker-submitted failure never disables VISP's reviewer.
    expect(await capacity(source)).toEqual({ available: true });
    await run({ operation: "review" }, failing());
    await run({ operation: "review" }, failing());
    expect(await capacity(source)).toMatchObject({
      available: false,
      reason: expect.stringContaining("failed twice on this source"),
    });
  });

  it("fails open when the budget cannot be read", async () => {
    await launch("codex-exec");
    await ready({ ...config, maxCalls: 1 });
    await run({ operation: "review" }, working());
    const ledger = join(
      setup.workspace.root,
      ".visp/features",
      setup.brief.feature,
      "critic-budget.json",
    );
    await writeFile(ledger, "{ not json");
    expect(await capacity(await subject())).toEqual({ available: true });
  });

  describe("routes", () => {
    const next = async () => {
      const result = await runProductNext(await setup.workspace.state(), { task: "T001" });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    it("requires repair before handing open findings to the human reviewer when calls are spent", async () => {
      await launch("codex-exec");
      await ready({ ...config, maxCalls: 1 });
      await run({ operation: "review" }, working(true));
      const step = await next();
      expect(step).toMatchObject({
        action: "fix",
        completion: "unresolved-product",
        command: `visp work --feature ${setup.brief.feature} --task T001`,
        mayEdit: true,
      });
      expect(step.objective).toContain("review budget is spent");
      expect(step.objective).toContain("cannot run again");
      expect(step.objective).toContain("still open");
      expect(step.objective).toContain("Fix each");
      expect(step.objective).toContain("extend");
      expect(step.objective).toContain("visp done");
      expect(step.evidence.join(" ")).toContain(FINDING);
      // Re-running checks on unchanged source cannot establish repair.
      await subject();
      expect((await next()).completion).toBe("unresolved-product");
      await setup.workspace.write("src/value.mjs", "export const value = 2; // repaired\n");
      // A source change alone cannot establish passing current checks.
      expect((await next()).completion).toBe("unresolved-product");
      await subject();
      const handoff = await next();
      expect(handoff).toMatchObject({
        action: "fix",
        completion: "handoff",
        command: `visp pr --feature ${setup.brief.feature}`,
      });
      expect(handoff.objective).toContain("remaining findings go to a human reviewer");
      expect(handoff.objective).not.toContain("Fix what you can");
      const record = await readProductRecord(await setup.workspace.state(), {
        feature: setup.brief.feature,
      });
      if (!record.ok) throw new Error(record.error.message);
      expect(record.value.state.status).not.toBe("accepted");
      expect(record.value.state.acceptedSubject).toBeUndefined();
      expect(outstandingFeedback(record.value)).toEqual(
        expect.arrayContaining([expect.objectContaining({ problem: FINDING, required: true })]),
      );
    });

    it("requires a new repair when the latest completed review repeats an older finding", async () => {
      await launch("codex-exec");
      await ready({ ...config, maxCalls: 2 });
      await run({ operation: "review" }, working(true));
      await edit("first repair");
      await run({ operation: "review" }, working(true));
      const step = await next();
      expect(step).toMatchObject({
        action: "fix",
        completion: "unresolved-product",
        mayEdit: true,
        command: `visp work --feature ${setup.brief.feature} --task T001`,
      });
      await edit("second repair");
      expect((await next()).completion).toBe("handoff");
    });

    it("repairs untouched findings in another slice before a feature handoff", async () => {
      await launch("codex-exec");
      const workspace = await setup.workspace.state();
      expect(
        (
          await updateProductBrief(workspace, {
            brief: {
              ...setup.brief,
              slices: [...setup.brief.slices, { ...setup.brief.slices[0], id: "T002" }],
            },
            reason: "Two reviewed slices share a feature handoff",
          })
        ).ok,
      ).toBe(true);
      await ready({ ...config, maxCalls: 2 });
      expect(
        (
          await runProductCritic(await setup.workspace.state(), {
            task: "T002",
            operation: "configure",
            config: { ...config, maxCalls: 2 },
          })
        ).ok,
      ).toBe(true);
      await run({ operation: "review" }, working(true));
      await edit("first slice repaired");
      expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
      expect((await runProductVerify(await setup.workspace.state(), { task: "T002" })).ok).toBe(
        true,
      );
      expect(
        await runProductCritic(
          await setup.workspace.state(),
          {
            task: "T002",
            operation: "review",
          },
          working(true),
        ),
      ).toMatchObject({ ok: true, value: { callsUsed: 2 } });
      expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
      expect(await next()).toMatchObject({
        action: "fix",
        completion: "unresolved-product",
        command: `visp work --feature ${setup.brief.feature} --task T002`,
      });
      await edit("second slice repaired");
      // The first slice's passing check does not cover the second slice's current check.
      expect((await next()).completion).toBe("unresolved-product");
      expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
      expect((await runProductVerify(await setup.workspace.state(), { task: "T002" })).ok).toBe(
        true,
      );
      expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
      expect((await next()).completion).toBe("handoff");
    });

    it("keeps a changed product on repair when its checks fail", async () => {
      await launch("codex-exec");
      await ready({ ...config, maxCalls: 1 });
      await run({ operation: "review" }, working(true));
      await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
      const verified = await runProductVerify(await setup.workspace.state(), { task: "T001" });
      expect(verified).toMatchObject({ ok: true, value: { passed: false } });
      expect(await next()).toMatchObject({
        action: "fix",
        command: `visp work --feature ${setup.brief.feature} --task T001`,
      });
      expect((await next()).completion).not.toBe("handoff");
    });

    it("hands open findings over when the reviewer failed twice on this source, not after a change", async () => {
      await launch("codex-exec");
      await ready();
      await run({ operation: "review" }, working(true));
      await edit("changed");
      await run({ operation: "review" }, failing());
      expect((await next()).completion).not.toBe("handoff");
      await run({ operation: "review" }, failing());
      const stuck = await next();
      expect(stuck).toMatchObject({
        completion: "handoff",
        command: expect.stringContaining("visp pr"),
      });
      expect(stuck.objective).toContain("failed twice on this source");
      await edit("changed again");
      const again = await next();
      expect(again.completion).toBe("unresolved-product");
      expect(again.command).toContain("visp work");
    });

    it("keeps open findings on repair when the worker submitted a reviewer failure", async () => {
      await launch("codex-exec");
      await ready();
      await run({ operation: "review" }, working(true));
      await edit("changed");
      const prepared = await run({ operation: "prepare", capabilities });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const { attempt } = prepared.value as { attempt: string };
      await run({
        operation: "submit",
        result: { attempt, model: config.model, context: "fresh", failure: "Host gave up" },
      });
      const step = await next();
      expect(step.completion).toBe("unresolved-product");
      expect(step.command).not.toContain("visp pr");
    });

    it("keeps today's route for a host-review project whose budget is spent", async () => {
      await launch(undefined);
      await ready({ ...config, maxCalls: 1 });
      await run({ operation: "review" }, working(true));
      const step = await next();
      expect(step.completion).not.toBe("handoff");
      expect(step.command).not.toContain("visp pr");
    });

    it("requires repair of findings from a completed review even after the slice closed", async () => {
      await launch("codex-exec");
      await ready({ ...config, maxCalls: 1 });
      expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
        ok: true,
        value: { closed: true },
      });
      expect(await run({ operation: "review" }, working(true))).toMatchObject({
        ok: true,
        value: { callsUsed: 1 },
      });
      expect(await next()).toMatchObject({
        action: "fix",
        completion: "unresolved-product",
        mayEdit: true,
        command: `visp work --feature ${setup.brief.feature} --task T001`,
      });
      await edit("repair after closure");
      expect(await next()).toMatchObject({
        action: "fix",
        completion: "handoff",
        command: `visp pr --feature ${setup.brief.feature}`,
      });
    });

    it("hands the assembled product's assessment over instead of asking for a review it cannot get", async () => {
      await launch("codex-exec");
      await ready({ ...config, maxCalls: 1 });
      await run({ operation: "review" }, failing());
      await run({ operation: "review" }, failing());
      expect(await run({ operation: "status" })).toMatchObject({
        ok: true,
        value: { callsUsed: 0, featureBudget: { reservedMs: 2 * config.timeoutMs } },
      });
      expect((await runProductDone(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
      const step = await next();
      expect(step).toMatchObject({
        action: "fix",
        completion: "handoff",
        mayEdit: false,
        command: expect.stringContaining("visp pr"),
      });
      expect(step.objective).toContain("remaining assessment");
    });

    it("still asks VISP's reviewer to assess the assembled product while it has capacity", async () => {
      await launch("codex-exec");
      await ready();
      expect((await runProductDone(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
      const step = await next();
      expect(step).toMatchObject({
        action: "refine",
        command: expect.stringContaining("visp accept"),
      });
      expect(step.completion).not.toBe("handoff");
    });
  });
});
