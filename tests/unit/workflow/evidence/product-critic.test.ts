import { chmod, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import { criticNext } from "../../../../src/workflow/product/critic-guidance.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  maxCalls: 3,

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
function invalidResponse(kind: string, packet: CriticPacket): unknown {
  let response: unknown = answer(packet);
  if (kind === "circular") {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    response = circular;
  }
  if (kind === "too-large") response = { text: "x".repeat(64001) };
  if (kind === "wrong-selection")
    response = {
      ...answer(packet),
      review: { ...answer(packet).review, selection: undefined },
    };
  if (kind === "invented-captures")
    response = { ...answer(packet), review: { ...answer(packet).review, captures: [] } };
  if (kind === "duplicate-dimensions")
    response = {
      ...answer(packet),
      comparison: Array.from({ length: 2 }, () => ({
        dimension: "code",
        change: "same",
        reason: "duplicate",
      })),
    };

  return kind === "invalid" ? {} : response;
}

describe("optional bounded critic", () => {
  let setup: Awaited<ReturnType<typeof productWorkspace>>;
  beforeEach(async () => {
    setup = await productWorkspace({ critic: true });
  });
  afterEach(async () => {
    await setup.workspace.destroy();
  });
  const run = async (input: object, host?: ProductCriticHost) =>
    runProductCritic(await setup.workspace.state(), { task: "T001", ...input }, host);
  async function ready(limits = config) {
    expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
    const verified = await runProductVerify(await setup.workspace.state(), { task: "T001" });
    expect(verified.ok).toBe(true);
    expect((await run({ operation: "configure", config: limits })).ok).toBe(true);
  }
  async function dispatch(transform: (p: CriticPacket) => unknown = (p) => answer(p)) {
    return run(
      { operation: "review" },
      { review: async (packet) => ({ model: config.model, response: transform(packet) }) },
    );
  }
  it("reports incomplete default-on setup read-only and rejects unknown tasks", async () => {
    const before = await readdir(join(setup.workspace.root, ".visp/features", setup.brief.feature));
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { enabled: true, callsUsed: 0, stopped: expect.stringContaining("unconfigured") },
    });
    expect(
      await readdir(join(setup.workspace.root, ".visp/features", setup.brief.feature)),
    ).toEqual(before);
    const host = { review: vi.fn() };
    const result = await run({ operation: "review", task: "T404" }, host);
    expect(result).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
    expect(host.review).not.toHaveBeenCalled();
    const missing = { feature: "999-missing", task: "T001" };
    expect(
      await criticNext(await setup.workspace.state(), {
        ...missing,
        action: "refine",
        objective: "review",
        evidence: [],
        mayEdit: false,
      }),
    ).toMatchObject({ ok: true, value: { criticAdvice: { status: "unavailable" } } });
  });
  it("requires explicit settings and a usable slice; configuration cannot reset spent calls", async () => {
    expect(await run({ operation: "configure", config: {} })).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
    expect(await run({ operation: "review" })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run({ operation: "configure", config })).toMatchObject({ ok: true });
    expect(await run({ operation: "configure", config })).toMatchObject({
      ok: true,
      value: { unchanged: true },
    });
    expect(await run({ operation: "configure", config: { ...config, maxCalls: 2 } })).toMatchObject(
      { ok: false },
    );
    expect(await run({ operation: "review" }, { review: vi.fn() })).toMatchObject({
      ok: false,
      error: { code: "EVIDENCE_MISSING" },
    });
  });
  it("records an ordinary policy-4 review, preserves source, and fixes CODE citation revalidation", async () => {
    await ready();
    const result = await dispatch();
    expect(result).toMatchObject({
      ok: true,
      value: { action: "normal-acceptance", callsUsed: 1 },
    });
    if (!result.ok) throw new Error("review");
    const value = result.value as { candidates: { path: string }[]; preferredCandidate: string };
    expect(value.preferredCandidate).toMatch(/^CAN-/);
    const snapshot = JSON.parse(await readFile(value.candidates[0]?.path ?? "missing", "utf8"));
    expect(
      Buffer.from(
        snapshot.files.find((f: { path: string }) => f.path === "src/value.mjs").content,
        "base64",
      ).toString(),
    ).toContain("value = 2");
    const closed = await runProductDone(await setup.workspace.state(), { task: "T001" });
    expect(closed).toMatchObject({ ok: true, value: { passed: true, closed: true } });
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
  });
  it("does not promote passing prose over a real failing behavior check", async () => {
    await ready();
    await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
    await runProductVerify(await setup.workspace.state(), { task: "T001" });
    const result = await dispatch();
    expect(result).toMatchObject({ ok: true, value: { action: "worker" } });
    if (result.ok)
      expect(result.value).not.toHaveProperty("preferredCandidate", expect.any(String));
  });
  it("returns a concrete finding to the worker without another critic call", async () => {
    await ready();
    const result = await dispatch((packet) => {
      const reply = answer(packet);
      reply.review.feedback.findings = [
        {
          dimension: "functional",
          problem: "The alternative invocation has not been verified",
          nextCheck: "Exercise the alternate invocation before changing its handler",
          outcomes: ["O001"],
          required: true,
          evidence: ["C001"],
        },
      ];
      return reply;
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        action: "worker",
        callsUsed: 1,
        findings: [expect.objectContaining({ required: true })],
      },
    });
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
  });
  it.each([
    "wrong-model",
    "truncated",
    "invalid",
    "unavailable",
    "circular",
    "too-large",
    "wrong-selection",
    "invented-captures",
    "duplicate-dimensions",
  ])("preserves a gap for %s and never retries automatically", async (kind) => {
    await ready();
    const host: ProductCriticHost = {
      review: vi.fn(async (packet) => {
        if (kind === "unavailable") throw new Error("no service");
        return {
          model: kind === "wrong-model" ? "another-model" : config.model,
          response: invalidResponse(kind, packet),
          truncated: kind === "truncated",
        };
      }),
    };
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: true,
      value: { action: "unresolved", callsUsed: 1 },
    });
    expect(await run({ operation: "review" }, host)).toMatchObject({ ok: false });
    expect(host.review).toHaveBeenCalledTimes(1);
    if (kind === "unavailable") {
      const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
      expect(next).toMatchObject({
        ok: true,
        value: {
          action: "implement",
          criticAdvice: { status: "unavailable" },
          mayEdit: true,
          command: expect.not.stringContaining("--dispatch"),
        },
      });
    }
  });
  it("discards feedback when source changes while the critic is running", async () => {
    await ready();
    const result = await run(
      { operation: "review" },
      {
        review: async (packet) => {
          await setup.workspace.write("src/value.mjs", "export const value = 7;\n");
          return { model: config.model, response: answer(packet) };
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        action: "unresolved",
        reason: expect.stringContaining("Source or contract changed"),
      },
    });
  });
  it("reserves calls across concurrent requests and reports interrupted reservations without replaying", async () => {
    await ready();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const running = run(
      { operation: "review" },
      {
        review: async (packet) => {
          entered();
          await hold;
          return { model: config.model, response: answer(packet) };
        },
      },
    );
    await enteredPromise;
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
    expect(await run({ operation: "disable" })).toMatchObject({
      ok: false,
      error: { code: "WORKFLOW_REPLACED" },
    });
    release();
    await running;
    const selected = await criticSelection(await setup.workspace.state(), { task: "T001" });
    if (!selected.ok) throw new Error("selection");
    const stored = await readCriticState(await setup.workspace.state(), selected.value);
    if (!stored.ok || !stored.value.state) throw new Error("state");
    const attempt = stored.value.state.attempts[0];
    if (!attempt) throw new Error("attempt");
    attempt.status = "pending";
    attempt.startedAt = 0;
    await writeFile(selected.value.path, JSON.stringify(stored.value.state));
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { stopped: expect.stringContaining("interrupted-review") },
    });
    expect(await run({ operation: "disable" })).toMatchObject({
      ok: false,
      error: { code: "WORKFLOW_REPLACED" },
    });
  });
  it("restores exact source with a current-subject guard and leaves evidence historical", async () => {
    await ready();
    const result = await dispatch();
    if (!result.ok) throw new Error("review");
    const value = result.value as { candidates: { id: string }[]; subjectDigest: string };
    await setup.workspace.write("src/value.mjs", "export const value = 9;\n");
    expect(
      await run({
        operation: "restore",
        candidate: value.candidates[0]?.id,
        expectedSubject: value.subjectDigest,
      }),
    ).toMatchObject({ ok: false, error: { code: "EVIDENCE_FAILED" } });
    const current = await run({ operation: "status" });
    if (!current.ok) throw new Error("status");
    const restore = await run({
      operation: "restore",
      candidate: value.candidates[0]?.id,
      expectedSubject: (current.value as { subjectDigest: string }).subjectDigest,
    });
    expect(restore).toMatchObject({ ok: true, value: { restored: value.candidates[0]?.id } });
    expect(await readFile(join(setup.workspace.root, "src/value.mjs"), "utf8")).toContain(
      "value = 2",
    );
  });
  it("enforces the call budget and keeps unresolved work visible after the last review", async () => {
    await ready({ ...config, maxCalls: 1 });
    const result = await dispatch((packet) => {
      const response = answer(packet);
      response.review.assessments[0] = {
        ...response.review.assessments[0],
        outcome: "O001",
        status: "unclear",
        summary: "Need a second independent behavior observation",
        evidence: [],
        expectations: [],
      };
      return response;
    });
    expect(result).toMatchObject({
      ok: true,
      value: { stopped: expect.stringContaining("budget exhausted") },
    });
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: "STAGE_BLOCKED" } });
    await runProductDone(await setup.workspace.state(), { task: "T001" });
    expect(await runProductAccept(await setup.workspace.state())).toMatchObject({
      ok: true,
      value: { passed: false },
    });
  });
  it("accepts a complete large response without a VISP character ceiling", async () => {
    await ready(config);
    const host = {
      review: vi.fn(async (packet: CriticPacket) => {
        const response = answer(packet);
        response.review.feedback.dimensions = response.review.feedback.dimensions.map((entry) => ({
          ...entry,
          reason: "Observed supporting evidence ".repeat(3000),
        }));
        return { model: config.model, response, outputTokens: 40000 };
      }),
    };
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: true,
      value: { callsUsed: 1, action: "normal-acceptance" },
    });
    expect(host.review).toHaveBeenCalledOnce();
  });

  it("times out once, aborts the host and never applies its late response", async () => {
    await ready({ ...config, timeoutMs: 1000 });
    let signal: AbortSignal | undefined;
    const result = await run(
      { operation: "review" },
      {
        review: async (packet, options) => {
          signal = options.signal;
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return { model: config.model, response: answer(packet) };
        },
      },
    );
    expect(result).toMatchObject({ ok: true, value: { action: "unresolved" } });
    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      value: {
        reason: expect.stringContaining("deadline exceeded"),
        lifecycle: {
          provenance: "adapter-observed",
          invoked: null,
          returned: false,
          adapterCall: {
            startedAt: expect.any(Number),
            finishedAt: expect.any(Number),
            outcome: "timed-out",
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { callsUsed: 1, next: "unresolved" },
    });
  });
  it("keeps a supported previous candidate when a revision is worse in one quality dimension", async () => {
    await ready();
    const initial = await dispatch();
    if (!initial.ok) throw new Error("review");
    const before = initial.value as { preferredCandidate: string };
    await setup.workspace.write(
      "src/value.mjs",
      "// revised layout helper\nexport const value = 2;\n",
    );
    await runProductVerify(await setup.workspace.state(), { task: "T001" });
    const result = await run(
      { operation: "review" },
      {
        review: async (packet) => ({
          model: config.model,
          response: {
            ...answer(packet),
            comparison: ["fidelity", "functional", "non-functional", "experience", "code"].map(
              (dimension) => ({
                dimension,
                change: dimension === "experience" ? "worse" : "same",
                reason: "Fixture comparison reports a user-visible regression",
              }),
            ),
          },
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        action: "worker",
        preferredCandidate: before.preferredCandidate,
        gaps: expect.arrayContaining([expect.stringContaining("regression")]),
      },
    });
    const advised = await runProductNext(await setup.workspace.state(), { task: "T001" });
    expect(advised).toMatchObject({
      ok: true,
      value: {
        criticAdvice: {
          comparisons: expect.arrayContaining([
            {
              dimension: "experience",
              change: "worse",
              reason: "Fixture comparison reports a user-visible regression",
            },
          ]),
        },
      },
    });
    // An uncited comparison is advice, not a new requirement or a failing check.
    expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
      ok: true,
      value: { passed: true },
    });
  });
  it("rejects tampered candidate bytes without editing source", async () => {
    await ready();
    const reviewed = await dispatch();
    if (!reviewed.ok) throw new Error("review");
    const status = reviewed.value as {
      candidates: { id: string; path: string }[];
      subjectDigest: string;
    };
    const candidate = status.candidates[0];
    if (!candidate) throw new Error("candidate");
    const saved = JSON.parse(await readFile(candidate.path, "utf8"));
    saved.files.find((file: { path: string }) => file.path === "src/value.mjs").content =
      Buffer.from("malformed replacement").toString("base64");
    await writeFile(candidate.path, JSON.stringify(saved));
    expect(
      await run({
        operation: "restore",
        candidate: candidate.id,
        expectedSubject: status.subjectDigest,
      }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect(await readFile(join(setup.workspace.root, "src/value.mjs"), "utf8")).toContain(
      "value = 2",
    );
  });
  it("does not overwrite unrelated changes during restoration", async () => {
    await ready();
    const reviewed = await dispatch();
    if (!reviewed.ok) throw new Error("review");
    const status = reviewed.value as { candidates: { id: string }[]; subjectDigest: string };
    await setup.workspace.write("unrelated.txt", "User work");
    expect(
      await run({
        operation: "restore",
        candidate: status.candidates[0]?.id,
        expectedSubject: status.subjectDigest,
      }),
    ).toMatchObject({ ok: false });
    expect(await readFile(join(setup.workspace.root, "unrelated.txt"), "utf8")).toBe("User work");
  });
  it("does not spend more calls on identical reruns or an unfulfilled evidence request", async () => {
    await ready();
    await run(
      { operation: "review" },
      {
        review: async (packet) => ({
          model: config.model,
          response: { ...answer(packet), evidenceRequest: "Measure the alternative invocation" },
        }),
      },
    );
    await runProductVerify(await setup.workspace.state(), { task: "T001" });
    const host = { review: vi.fn() };
    expect(await run({ operation: "review" }, host)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("different hypothesis") },
    });
    expect(host.review).not.toHaveBeenCalled();
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { callsUsed: 1, next: "worker" },
    });
    const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: {
        criticAdvice: { evidenceRequest: "Measure the alternative invocation" },
      },
    });
  });
  it("restores binary assets, deletions and executable modes without restoring review state", async () => {
    const brief = {
      ...setup.brief,
      slices: setup.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: [...slice.scope.allowed, "src/**"] },
      })),
    };
    expect(
      (
        await updateProductBrief(await setup.workspace.state(), {
          brief,
          reason: "Allow the slice assets",
        })
      ).ok,
    ).toBe(true);
    await ready();
    const asset = join(setup.workspace.root, "src/asset.bin");
    await writeFile(asset, Buffer.from([0, 255, 128, 1]));
    await chmod(asset, 0o755);
    await runProductVerify(await setup.workspace.state(), { task: "T001" });
    const reviewed = await dispatch((packet) => ({
      ...answer(packet),
      comparison: (packet as unknown as { previous?: unknown }).previous
        ? ["fidelity", "functional", "non-functional", "experience", "code"].map((dimension) => ({
            dimension,
            change: "same",
            reason:
              "The binary fixture preserves the public module behavior; asset modes and deletion are checked separately",
          }))
        : [],
    }));
    if (!reviewed.ok) throw new Error("review");
    const saved = reviewed.value as { candidates: { id: string }[] };
    await rm(asset);
    await setup.workspace.write("src/added.mjs", "export const added=true;");
    const current = await run({ operation: "status" });
    if (!current.ok) throw new Error("status");
    const statePath = join(
      setup.workspace.root,
      ".visp/features",
      brief.feature,
      "product-state.json",
    );
    const beforeState = await readFile(statePath, "utf8");
    expect(
      await run({
        operation: "restore",
        candidate: saved.candidates[0]?.id,
        expectedSubject: (current.value as { subjectDigest: string }).subjectDigest,
      }),
    ).toMatchObject({ ok: true });
    expect(await readFile(asset)).toEqual(Buffer.from([0, 255, 128, 1]));
    expect((await stat(asset)).mode & 0o777).toBe(0o755);
    await expect(stat(join(setup.workspace.root, "src/added.mjs"))).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe(beforeState);
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { next: "normal-acceptance" },
    });
  });
  it("rejects symlink substitution without touching its target", async () => {
    await ready();
    const reviewed = await dispatch();
    if (!reviewed.ok) throw new Error("review");
    const saved = reviewed.value as { candidates: { id: string }[]; subjectDigest: string };
    const source = join(setup.workspace.root, "src/value.mjs");
    await rm(source);
    await symlink("../test/value.test.mjs", source);
    const target = await readFile(join(setup.workspace.root, "test/value.test.mjs"), "utf8");
    expect(
      await run({
        operation: "restore",
        candidate: saved.candidates[0]?.id,
        expectedSubject: saved.subjectDigest,
      }),
    ).toMatchObject({ ok: false });
    expect(await readFile(join(setup.workspace.root, "test/value.test.mjs"), "utf8")).toBe(target);
  });
  it("routes refinement to the configured critic and returns a finding to normal work", async () => {
    await ready();
    const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
    expect(next).toMatchObject({
      ok: true,
      value: { criticAdvice: { command: expect.stringContaining("critic") } },
    });
    await dispatch((packet) => {
      const response = answer(packet);
      const assessment = response.review.assessments[0];
      if (!assessment) throw new Error("assessment");
      assessment.status = "unclear";
      return response;
    });
    if (!next.ok) throw new Error("next");
    expect(await criticNext(await setup.workspace.state(), next.value)).toMatchObject({
      ok: true,
      value: { mayEdit: true, criticAdvice: { status: "feedback" } },
    });
  });
  it("discards review when an image actually supplied to the critic disappears", async () => {
    await ready();
    await recordedProductJourney(setup.workspace, "critic-image");
    const result = await run(
      { operation: "review" },
      {
        review: async (packet) => {
          expect(packet.current.images).toHaveLength(2);
          await rm(join(setup.workspace.root, ".visp/reports/critic-image-after.png"));
          return { model: config.model, response: answer(packet) };
        },
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { action: "unresolved", reason: expect.stringContaining("images") },
    });
  });
  it("accepts a researched method revision without resetting calls or promoting metadata as improvement", async () => {
    await ready();
    const first = await dispatch();
    if (!first.ok) throw new Error("first review");
    const baseline = first.value as { preferredCandidate: string; candidates: { id: string }[] };
    const revised = await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        decisions: [
          {
            id: "D001",
            statement: "Keep the exported value constant",
            rationale: "Tracing the public import shows no mutable state is needed",
            evidence: [],
            implications: ["Keep the equality check at the public boundary"],
            outcomes: ["O001"],
          },
        ],
      },
      reason: "Use the code investigation to simplify the implementation decision",
    });
    expect(revised.ok).toBe(true);
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { callsUsed: 1, next: "review" },
    });
    expect(await dispatch()).toMatchObject({ ok: false, error: { code: "EVIDENCE_MISSING" } });
    expect(await run({ operation: "configure", config })).toMatchObject({
      ok: true,
      value: { unchanged: true },
    });
    expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
    await runProductVerify(await setup.workspace.state(), { task: "T001" });
    const second = await run(
      { operation: "review" },
      {
        review: async (packet) => {
          expect(packet).not.toHaveProperty("previous");
          expect(packet.current).not.toHaveProperty("agenda");
          expect(packet.current.sources.some((source) => source.kind === "authored-brief")).toBe(
            false,
          );
          return {
            model: config.model,
            response: {
              ...answer(packet),
              comparison: ["fidelity", "functional", "non-functional", "experience", "code"].map(
                (dimension) => ({
                  dimension,
                  change: "better",
                  reason: "Deliberately overclaims a metadata-only revision",
                }),
              ),
            },
          };
        },
      },
    );
    expect(second).toMatchObject({
      ok: true,
      value: {
        callsUsed: 2,
        next: "normal-acceptance",
        preferredCandidate: baseline.preferredCandidate,
      },
    });
    const current = await run({ operation: "status" });
    if (!current.ok) throw new Error("status");
    expect(
      await run({
        operation: "restore",
        candidate: baseline.candidates[0]?.id,
        expectedSubject: (current.value as { subjectDigest: string }).subjectDigest,
      }),
    ).toMatchObject({ ok: true });
    const selected = await criticSelection(await setup.workspace.state(), { task: "T001" });
    expect(selected.ok && selected.value.record.brief.decisions[0]?.id).toBe("D001");
  });
  it("does not carry critic approval across an explicit change to an outcome", async () => {
    await ready();
    await dispatch();
    expect(
      (
        await updateProductBrief(await setup.workspace.state(), {
          brief: {
            ...setup.brief,
            outcomes: setup.brief.outcomes.map((outcome) => ({
              ...outcome,
              statement: "The value may be any positive number",
            })),
          },
          intentChange: {
            reason: "Fixture models an explicit change of goal",
            provenance: "test-fixture; not human authentication",
          },
        })
      ).ok,
    ).toBe(true);
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: {
        callsUsed: 1,
        next: "review",
        callsRemaining: 2,
      },
    });
  });
});
