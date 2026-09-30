import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import type { CriticState } from "../../../../src/workflow/product/critic-model.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import { inlineReview } from "../../../../src/workflow/product/done-review.js";
import { runProductVerify } from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  maxCalls: 5,
  timeoutMs: 5000,
  maxImageBytes: 4 * 1024 * 1024,
};

function answer(packet: CriticPacket) {
  return {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((o) => ({
        outcome: o.id,
        status: "satisfied",
        summary: "Executed the module and observed the promised value",
        evidence: ["C001"],
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  };
}

describe("VISP-launched reviewer relaunch", () => {
  let setup: Awaited<ReturnType<typeof productWorkspace>>;
  const failing = (): ProductCriticHost => ({
    review: vi.fn(async () => {
      throw new Error("codex exec crashed");
    }),
  });
  const working = (): ProductCriticHost => ({
    review: vi.fn(async (packet) => ({ model: config.model, response: answer(packet) })),
  });

  // What codexExecCriticHost is: capabilities come from inspect, so VISP's own attempts are recorded native.
  const launchedCapabilities = {
    harness: "codex" as const,
    model: config.model,
    freshContext: true,
    images: true,
    readOnly: true,
    delegationAllowed: true,
  };
  const attached = (host: ProductCriticHost): ProductCriticHost => ({
    inspect: async () => launchedCapabilities,
    review: async (packet, options) => ({
      context: "fresh" as const,
      ...(await host.review(packet, options)),
    }),
  });

  async function launch(value: "codex-exec" | undefined) {
    const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
    raw.critic = { ...raw.critic, harness: "codex", mode: "auto", launch: value };
    await setup.workspace.write("visp.yml", stringify(raw));
    setup.workspace.commit("reviewer launch mode");
  }
  const run = async (input: object, host?: ProductCriticHost) =>
    runProductCritic(await setup.workspace.state(), { task: "T001", ...input }, host);
  async function ready(limits: object = config) {
    expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    expect((await run({ operation: "configure", config: limits })).ok).toBe(true);
  }
  const nativeConfig = { ...config, harness: "codex", transport: "native" };
  async function criticFile() {
    const workspace = await setup.workspace.state();
    const selected = await criticSelection(workspace, { task: "T001" });
    if (!selected.ok) throw new Error("selection");
    const stored = await readCriticState(workspace, selected.value);
    if (!stored.ok || !stored.value.state) throw new Error("state");
    return { path: selected.value.path, state: stored.value.state };
  }
  async function rewrite(change: (state: CriticState) => void) {
    const { path, state } = await criticFile();
    change(state);
    await writeFile(path, JSON.stringify(state));
  }
  const statuses = async () => (await criticFile()).state.attempts.map((a) => a.status);

  beforeEach(async () => {
    setup = await productWorkspace({ critic: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await setup.workspace.destroy();
  });

  it("starts a fresh review after the first infrastructure failure on a source", async () => {
    await launch("codex-exec");
    await ready();
    expect(await run({ operation: "review" }, failing())).toMatchObject({
      ok: true,
      value: { action: "unresolved", callsUsed: 1 },
    });
    const host = working();
    const second = await run({ operation: "review" }, host);
    expect(second).toMatchObject({ ok: true, value: { callsUsed: 2 } });
    expect(host.review).toHaveBeenCalledTimes(1);
    expect(await statuses()).toEqual(["unavailable", "reviewed"]);
  });

  it("refuses a third attempt on the same source and reports it without the host-review tail", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await run({ operation: "review" }, failing());
    const host = working();
    const third = await run({ operation: "review" }, host);
    expect(third).toMatchObject({
      ok: false,
      error: {
        code: "STAGE_BLOCKED",
        message: expect.stringContaining("Previous critic attempt unavailable"),
      },
    });
    if (third.ok) throw new Error("expected refusal");
    expect(third.error.message).toContain("VISP's reviewer will try again on the next visp done");
    expect(third.error.message).not.toContain("baseline host review");
    expect(host.review).not.toHaveBeenCalled();
    expect(await statuses()).toEqual(["unavailable", "unavailable"]);
    const status = await run({ operation: "status" });
    expect(status).toMatchObject({
      ok: true,
      value: { callsUsed: 2, stopped: expect.stringContaining("Previous critic attempt") },
    });
  });

  it("qualifies a changed source again after two failures, within the call budget", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await run({ operation: "review" }, failing());
    await setup.workspace.write("src/value.mjs", "export const value = 2; // changed\n");
    expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    const host = working();
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: true,
      value: { callsUsed: 3 },
    });
    expect(host.review).toHaveBeenCalledTimes(1);
    expect(await statuses()).toEqual(["unavailable", "unavailable", "reviewed"]);
  });

  it("converts an expired pending attempt into an unavailable one without spending a call", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.failureKind = undefined;
      attempt.message = undefined;
      attempt.startedAt = 0;
    });
    const host = working();
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: true,
      value: { callsUsed: 2 },
    });
    const { state } = await criticFile();
    expect(state.attempts[0]).toMatchObject({
      status: "unavailable",
      failureKind: "invocation-failed",
      message: "The reviewer process ended without a result before its deadline",
    });
    expect(state.attempts[1]?.status).toBe("reviewed");
  });

  it("keeps a review that is still inside its deadline in progress", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.startedAt = Date.now();
    });
    const host = working();
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: false,
      error: { message: "review-in-progress" },
    });
    expect(host.review).not.toHaveBeenCalled();
  });

  it("blocks after two expired pending attempts on the same source", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await run({ operation: "review" }, failing());
    await rewrite((state) => {
      for (const attempt of state.attempts) {
        attempt.status = "pending";
        attempt.startedAt = 0;
      }
    });
    const host = working();
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("interrupted-review") },
    });
    expect(host.review).not.toHaveBeenCalled();
  });

  it("never overrides a failure the host reported (native transport)", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.transport = "native";
      attempt.launcher = undefined;
      attempt.execution = { provenance: "host-reported", returned: false };
    });
    const host = working();
    const retried = await run({ operation: "review" }, host);
    expect(retried).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Previous critic attempt unavailable") },
    });
    if (retried.ok) throw new Error("expected refusal");
    expect(retried.error.message).toContain("does not retry a failure the host reported");
    expect(host.review).not.toHaveBeenCalled();
  });

  it("tells the worker a review in progress is still running, not that the critic failed", async () => {
    await launch("codex-exec");
    await ready();
    await run({ operation: "review" }, failing());
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.startedAt = Date.now();
    });
    const host = working();
    const summary = await inlineReview(host)(await setup.workspace.state(), {
      feature: setup.brief.feature,
      task: "T001",
    });
    expect(summary).toMatchObject({
      reviewed: false,
      reason: "VISP's reviewer is still running. Wait: run visp next.",
    });
    expect(host.review).not.toHaveBeenCalled();
  });

  it("changes nothing without a VISP-launched reviewer", async () => {
    await launch(undefined);
    await ready();
    await run({ operation: "review" }, failing());
    const host = working();
    const second = await run({ operation: "review" }, host);
    expect(second).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("continue baseline host review") },
    });
    expect(host.review).not.toHaveBeenCalled();
    await rewrite((state) => {
      const [attempt] = state.attempts;
      if (!attempt) throw new Error("attempt");
      attempt.status = "pending";
      attempt.startedAt = 0;
    });
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("interrupted-review") },
    });
    expect((await criticFile()).state.attempts[0]?.status).toBe("pending");
  });

  describe("with the shape codex-exec really has (inspect reports capabilities, transport native)", () => {
    it("relaunches after one failure and stamps the attempts as VISP-launched", async () => {
      await launch("codex-exec");
      await ready(nativeConfig);
      expect(await run({ operation: "review" }, attached(failing()))).toMatchObject({
        ok: true,
        value: { action: "unresolved", callsUsed: 1 },
      });
      const host = working();
      expect(await run({ operation: "review" }, attached(host))).toMatchObject({
        ok: true,
        value: { callsUsed: 2 },
      });
      expect(host.review).toHaveBeenCalledTimes(1);
      const { attempts } = (await criticFile()).state;
      expect(attempts.map((a) => a.status)).toEqual(["unavailable", "reviewed"]);
      expect(attempts.map((a) => [a.transport, a.launcher])).toEqual([
        ["native", "visp"],
        ["native", "visp"],
      ]);
    });

    it("relaunches after an expired pending attempt and blocks after two failures on a source", async () => {
      await launch("codex-exec");
      await ready(nativeConfig);
      await run({ operation: "review" }, attached(failing()));
      await rewrite((state) => {
        const [attempt] = state.attempts;
        if (!attempt) throw new Error("attempt");
        attempt.status = "pending";
        attempt.startedAt = 0;
      });
      await run({ operation: "review" }, attached(failing()));
      const host = working();
      // The attached host inspects first, so a refusal is reported as an unready preflight.
      const third = await run({ operation: "review" }, attached(host));
      expect(third).toMatchObject({ ok: true, value: { ready: false } });
      if (!third.ok) throw new Error("expected preflight");
      const gaps = (third.value as { gaps: string[] }).gaps.join(" ");
      expect(gaps).toContain("Previous critic attempt unavailable");
      expect(gaps).toContain("will try again on the next visp done");
      expect(gaps).not.toContain("host reported");
      expect(host.review).not.toHaveBeenCalled();
      expect((await criticFile()).state.attempts.map((a) => a.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);
    });

    it("treats an attempt from before the launcher stamp by its execution provenance", async () => {
      await launch("codex-exec");
      await ready(nativeConfig);
      await run({ operation: "review" }, attached(failing()));
      const legacy = async (provenance: "adapter-observed" | "host-reported") =>
        rewrite((state) => {
          const [attempt] = state.attempts;
          if (!attempt) throw new Error("attempt");
          attempt.launcher = undefined;
          attempt.execution = { provenance, claimed: true, returned: false };
        });
      await legacy("host-reported");
      const blockedHost = working();
      const blocked = await run({ operation: "review" }, attached(blockedHost));
      expect(blocked).toMatchObject({ ok: true, value: { ready: false } });
      expect(blockedHost.review).not.toHaveBeenCalled();
      await legacy("adapter-observed");
      const host = working();
      expect(await run({ operation: "review" }, attached(host))).toMatchObject({
        ok: true,
        value: { callsUsed: 2 },
      });
      expect(host.review).toHaveBeenCalledTimes(1);
    });

    it("still blocks an attempt a host reported through prepare and submit", async () => {
      await launch("codex-exec");
      await ready(nativeConfig);
      const prepared = await run({ operation: "prepare", capabilities: launchedCapabilities });
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
      expect((await criticFile()).state.attempts[0]).toMatchObject({
        status: "unavailable",
        transport: "native",
      });
      const host = working();
      const retried = await run({ operation: "review" }, attached(host));
      expect(retried).toMatchObject({ ok: true, value: { ready: false } });
      if (!retried.ok) throw new Error("expected preflight");
      expect((retried.value as { gaps: string[] }).gaps.join(" ")).toContain(
        "does not retry a failure the host reported",
      );
      expect(host.review).not.toHaveBeenCalled();
    });
  });
});
