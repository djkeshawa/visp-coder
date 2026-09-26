import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as commandInput from "../../../../src/cli/input.js";
import { balancedCritic, CRITIC_HARNESSES } from "../../../../src/config/critic.js";
import { hashValue } from "../../../../src/core/hash.js";
import { applicableExecutions } from "../../../../src/workflow/product/assessment.js";
import { type CriticPacket, runProductCritic } from "../../../../src/workflow/product/critic.js";
import {
  nativeCapabilityGaps,
  nativePacket,
} from "../../../../src/workflow/product/critic-native.js";
import { criticSelection, readCriticState } from "../../../../src/workflow/product/critic-store.js";
import { productFailureSignature } from "../../../../src/workflow/product/failures.js";
import {
  runProductNext,
  runProductVerify,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductReviewerHandoff } from "../../../../src/workflow/product/reviewer-handoff.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import * as productSubject from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { runJson } from "../../cli/support/cli.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const preset = balancedCritic("codex");
if (!preset) throw new Error("Missing preset");
const config = { ...preset, maxCalls: 2 };
if (!config) throw new Error("missing preset");
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
};
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});
const run = async (input: object) =>
  runProductCritic(await setup.workspace.state(), { task: "T001", ...input });

async function ready(limits = config) {
  expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  expect((await run({ operation: "configure", config: limits })).ok).toBe(true);
}
async function prepare() {
  const result = await run({ operation: "prepare", capabilities });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const value = result.value as { attempt: string; packetPath: string; expiresAt: number };
  const packet = JSON.parse(await readFile(value.packetPath, "utf8")) as CriticPacket;
  return { ...value, packet };
}

it("executes the advertised stdin preparation without invalidating verified product evidence", async () => {
  await ready();
  const workspace = await setup.workspace.state();
  const before = await productSubject.productSourceDigest(workspace);
  const preflight = await run({ operation: "preflight", capabilities });
  if (!preflight.ok) throw new Error(preflight.error.message);
  const discovery = preflight.value as { prepareCommand: string; hostSetup: unknown };
  expect(discovery.hostSetup).toMatchObject({
    dispatch: {
      capabilityInput: { preferred: "stdin", fileAlternative: ".visp/critic-capabilities.json" },
    },
  });
  expect(discovery.prepareCommand).toContain("--capabilities -");
  const readInput = commandInput.readCommandInput;
  const supplied = vi
    .spyOn(commandInput, "readCommandInput")
    .mockImplementation((state, path) =>
      readInput(state, path, Readable.from([JSON.stringify(capabilities)])),
    );
  const prepared = await runJson(
    workspace.paths.root,
    ...discovery.prepareCommand.split(" ").slice(1),
  );
  expect(supplied).toHaveBeenCalledWith(expect.anything(), "-");
  expect(prepared.envelope).toMatchObject({ ok: true, data: { attempt: expect.any(String) } });
  expect(await productSubject.productSourceDigest(await setup.workspace.state())).toEqual(before);
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
});

it("retains a host report under .visp without ignoring similarly named product inputs", async () => {
  await ready();
  const workspace = await setup.workspace.state();
  const before = await productSubject.productSourceDigest(workspace);
  await setup.workspace.write(".visp/critic-capabilities.json", JSON.stringify(capabilities));
  expect(await productSubject.productSourceDigest(workspace)).toEqual(before);
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true },
  });
  await setup.workspace.write("critic-capabilities.json", JSON.stringify(capabilities));
  expect(await productSubject.productSourceDigest(workspace)).not.toEqual(before);
  const snapshot = await productSubject.productSourceSnapshot(workspace);
  expect(snapshot.ok && snapshot.value["critic-capabilities.json"]).toEqual(expect.any(String));
  // No filename or JSON-wide ignore: these may be real product configuration.
  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  expect(await productSubject.productSourceDigest(workspace)).not.toEqual(before);
});
function answer(packet: CriticPacket) {
  return {
    review: {
      ...legacyReview(packet),
      assessments: packet.current.outcomes.map((o) => ({
        outcome: o.id,
        status: "satisfied",
        summary: "Observed the promised value through execution",
        evidence: ["C001"],
        expectations: [],
      })),
      feedback: moduleFeedback(packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  };
}

it("preflights without writes, never spends budget on unavailable capabilities, and schedules native review", async () => {
  await ready();
  const dir = join(setup.workspace.root, ".visp/features", setup.brief.feature, "critic");
  const before = await readdir(dir);
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true, callsUsed: 0 },
  });
  expect(await readdir(dir)).toEqual(before);
  for (const change of [
    { model: "wrong" },
    { reasoningEffort: "low" },
    { harness: "cursor" },
    { freshContext: false },
    { readOnly: false },
    { delegationAllowed: false },
    { delegationAllowed: undefined },
  ]) {
    expect(
      await run({ operation: "prepare", capabilities: { ...capabilities, ...change } }),
    ).toMatchObject({ ok: false });
  }
  expect(await run({ operation: "prepare" })).toMatchObject({ ok: false });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 0 } });
  expect(await readdir(dir)).toEqual(before);
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { criticAdvice: { command: expect.stringContaining("--preflight") } },
  });
});

it("distinguishes unreported setup from a confirmed host refusal before spending a call", async () => {
  await ready();
  expect(await run({ operation: "preflight" })).toMatchObject({
    ok: true,
    value: {
      status: "setup-needed",
      ready: false,
      callsUsed: 0,
      hostSetup: {
        dispatch: { method: "native-handoff" },
        delegation: {
          reviewer: { harness: "codex", model: config.model, reasoningEffort: "high" },
          provider: "host-configured; not resolved by VISP",
          payload: { projectEvidence: true, images: false },
          authorization: expect.stringContaining("already supplied"),
        },
      },
    },
  });
  expect(
    await run({
      operation: "preflight",
      capabilities: { ...capabilities, delegationAllowed: false },
    }),
  ).toMatchObject({
    ok: true,
    value: { status: "unavailable", ready: false, callsUsed: 0 },
  });
  const { delegationAllowed: _unreported, ...unreportedCapabilities } = capabilities;
  expect(await run({ operation: "preflight", capabilities: unreportedCapabilities })).toMatchObject(
    {
      ok: true,
      value: { status: "unavailable", ready: false, callsUsed: 0 },
    },
  );
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { status: "ready", ready: true, callsUsed: 0 },
  });
});

it("inspects an attached adapter, invokes once and records observed lifecycle without native envelope work", async () => {
  await ready();
  const inspect = vi.fn(
    async () =>
      capabilities as NonNullable<
        import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
      >,
  );
  const review = vi.fn(async (packet: CriticPacket) => ({
    model: config.model,
    reasoningEffort: "high" as const,
    context: "fresh" as const,
    response: answer(packet),
  }));
  const host = { inspect, review };
  expect(
    await runProductCritic(
      await setup.workspace.state(),
      { task: "T001", operation: "preflight" },
      host,
    ),
  ).toMatchObject({ ok: true, value: { ready: true, dispatchMethod: "attached-adapter" } });
  expect(review).not.toHaveBeenCalled();
  expect(
    await runProductCritic(
      await setup.workspace.state(),
      { task: "T001", operation: "review" },
      host,
    ),
  ).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      assessmentCurrent: true,
      reviewCapacity: { limit: 2, understandingCalls: 0, productCalls: 1, remainingCalls: 1 },
      lifecycle: {
        invoked: true,
        returned: true,
        acceptedReview: true,
        provenance: "adapter-observed",
      },
    },
  });
  await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
  );
  expect(review).toHaveBeenCalledTimes(1);
  await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: {
      assessmentCurrent: false,
      lifecycle: { acceptedReview: true, provenance: "adapter-observed" },
      callsUsed: 1,
      reviewCapacity: { limit: 2, understandingCalls: 0, productCalls: 1, remainingCalls: 1 },
    },
  });
});

it("spends no call when the attached adapter reports a real refusal", async () => {
  await ready();
  const review = vi.fn();
  expect(
    await runProductCritic(
      await setup.workspace.state(),
      { task: "T001", operation: "review" },
      {
        inspect: async () => ({ unavailable: "Host policy denies delegation" }),
        review,
      },
    ),
  ).toMatchObject({ ok: true, value: { ready: false, status: "unavailable", callsUsed: 0 } });
  expect(review).not.toHaveBeenCalled();
});

it("records a synchronous adapter throw once without an unhandled timeout rejection or retry", async () => {
  await ready();
  const host = {
    inspect: async () =>
      capabilities as NonNullable<
        import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
      >,
    review: vi.fn(() => {
      throw new Error("Adapter startup failed before returning a promise");
    }),
  };
  const result = await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      reason: "Adapter startup failed before returning a promise",
      lifecycle: { invocationClaimed: true, returned: false, acceptedReview: false },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
  );
  expect(host.review).toHaveBeenCalledOnce();
});

it("reserves one candidate, submits a native result, and refuses replay and unchanged re-review", async () => {
  await ready();
  const prepared = await prepare();
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({ ok: false });
  const result = {
    attempt: prepared.attempt,
    model: config.model,
    reasoningEffort: "high",
    context: "fresh",
    outputTokens: 1000,
    response: answer(prepared.packet),
  };
  expect(await run({ operation: "submit", result })).toMatchObject({
    ok: true,
    value: { action: "normal-acceptance", callsUsed: 1 },
  });
  expect(await run({ operation: "submit", result })).toMatchObject({ ok: false });
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({ ok: false });
  expect(await readFile(join(setup.workspace.root, "src/value.mjs"), "utf8")).toBe(
    "export const value = 2;\n",
  );
});

it("does not credit a legacy pending review with unreported delegation authorization", async () => {
  await ready();
  const prepared = await prepare();
  const workspace = await setup.workspace.state();
  const selected = await criticSelection(workspace, { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const stored = await readCriticState(workspace, selected.value);
  if (!stored.ok || !stored.value.state) throw new Error("Missing pending review");
  const state = stored.value.state;
  await writeFile(
    selected.value.path,
    JSON.stringify({
      ...state,
      attempts: state.attempts.map((attempt) =>
        attempt.id === prepared.attempt
          ? { ...attempt, hostReport: { ...capabilities, delegationAllowed: undefined } }
          : attempt,
      ),
    }),
  );
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: prepared.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(prepared.packet),
      },
    }),
  ).toMatchObject({
    ok: true,
    value: {
      action: "unresolved",
      callsUsed: 1,
      reason: expect.stringContaining("delegation authorization"),
    },
  });
  const after = await readCriticState(workspace, selected.value);
  expect(after.ok && after.value.state?.attempts.at(-1)?.status).toBe("unavailable");
});

it("does not re-review one slice after only another slice's check changes", async () => {
  const first = setup.brief.slices[0];
  const check = setup.brief.checks[0];
  if (!first || !check) throw new Error("Missing fixture slice or check");
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      checks: [...setup.brief.checks, { ...check, id: "C002" }],
      slices: [...setup.brief.slices, { ...first, id: "T002", checks: ["C002"] }],
    },
    reason: "Give the second slice a separate check",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await ready();
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: prepared.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        outputTokens: 1000,
        response: answer(prepared.packet),
      },
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  expect((await runProductVerify(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", message: expect.stringContaining("already reviewed") },
  });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
});

it("keeps a legacy broad fingerprint from reopening an unchanged slice review", async () => {
  const first = setup.brief.slices[0];
  const check = setup.brief.checks[0];
  if (!first || !check) throw new Error("Missing fixture slice or check");
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      checks: [...setup.brief.checks, { ...check, id: "C002" }, { ...check, id: "C003" }],
      slices: [
        ...setup.brief.slices,
        { ...first, id: "T002", checks: ["C002"] },
        { ...first, id: "T003", checks: ["C003"] },
      ],
    },
    reason: "Preserve a historical broad critic fingerprint",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  await ready();
  expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  expect((await runProductVerify(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: prepared.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(prepared.packet),
      },
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  const state = await setup.workspace.state();
  const record = await readProductRecord(state);
  const handoff = await runProductReviewerHandoff(state, { task: "T001" });
  const selected = await criticSelection(state, { task: "T001" });
  if (!record.ok || !handoff.ok || !selected.ok)
    throw new Error("Missing historical review evidence");
  const broadDigest = hashValue({
    checks: [
      ...new Set(
        applicableExecutions(record.value, handoff.value.subjectDigest).map(
          productFailureSignature,
        ),
      ),
    ].sort(),
    images: handoff.value.images.map((image) => image.sha256),
    observations: handoff.value.evidence
      .filter((entry) => ["operation", "control"].includes(entry.kind))
      .map(({ kind, status, summary, measurement }) => ({ kind, status, summary, measurement })),
  });
  const history = JSON.parse(await readFile(selected.value.path, "utf8"));
  expect(broadDigest).not.toBe(history.attempts[0].evidenceDigest);
  history.attempts[0].evidenceDigest = broadDigest;
  delete history.attempts[0].evidenceScope;
  await writeFile(selected.value.path, JSON.stringify(history));
  expect((await runProductWork(await setup.workspace.state(), { task: "T003" })).ok).toBe(true);
  expect((await runProductVerify(await setup.workspace.state(), { task: "T003" })).ok).toBe(true);
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", message: expect.stringContaining("already reviewed") },
  });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
});

it("permits a new review when the selected slice supplies a different observation", async () => {
  await setup.workspace.write(
    "test/value.test.mjs",
    `${await readFile(join(setup.workspace.root, "test/value.test.mjs"), "utf8")}console.log('observation:' + process.hrtime.bigint());\n`,
  );
  await ready();
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: prepared.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(prepared.packet),
      },
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  const current = await readProductRecord(await setup.workspace.state());
  if (!current.ok) throw new Error(current.error.message);
  expect(current.value.state.executions.slice(-2).map((entry) => entry.output)).toEqual([
    expect.stringContaining("observation:"),
    expect.stringContaining("observation:"),
  ]);
  const recent = current.value.state.executions.slice(-2);
  if (recent.length !== 2 || !recent[0] || !recent[1])
    throw new Error("Missing two observed checks");
  expect(productFailureSignature(recent[0])).not.toBe(productFailureSignature(recent[1]));
  const subject = await productSubject.productSourceDigest(await setup.workspace.state());
  if (!subject.ok) throw new Error(subject.error.message);
  expect(recent.map((entry) => entry.subjectDigest)).toEqual([subject.value, subject.value]);
  const slice = current.value.brief.slices[0];
  if (!slice) throw new Error("Missing selected slice");
  expect(
    applicableExecutions(current.value, subject.value, slice).map((entry) => entry.output),
  ).toHaveLength(2);
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({
    ok: true,
    value: { attempt: expect.any(String) },
  });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 2 } });
});

it.each(["model", "effort", "context", "truncated", "source", "failure", "deadline"])(
  "rejects %s failures and retains the spent reservation",
  async (kind) => {
    await ready();
    const p = await prepare();
    if (kind === "deadline") vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    if (kind === "source")
      await setup.workspace.write("src/value.mjs", "export const value = 3;\n");
    const result = {
      attempt: p.attempt,
      model: kind === "model" ? "other" : config.model,
      reasoningEffort: kind === "effort" ? "low" : "high",
      context: kind === "context" ? "current" : "fresh",
      truncated: kind === "truncated",
      outputTokens: 1000,
      response: answer(p.packet),
      ...(kind === "failure" ? { failure: "Host cannot dispatch" } : {}),
    };
    expect(await run({ operation: "submit", result })).toMatchObject({
      ok: true,
      value: { action: "unresolved", callsUsed: 1 },
    });
    expect(await run({ operation: "configure", config })).toMatchObject({
      ok: true,
      value: { unchanged: true },
    });
    expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  },
);

it("copies current and previous image bytes without text-only visual claims", () => {
  const packet = {
    current: { images: [{ data: "YQ==", mimeType: "image/png" }] },
    previous: { evidence: { images: [{ data: "Yg==", mimeType: "image/png" }] } },
  } as unknown as CriticPacket;
  const planned = nativePacket(packet, "/tmp/native-packet", config);
  if (!planned.ok) throw new Error(planned.error.message);
  const prepared = planned.value;
  expect(prepared.handoff.images).toHaveLength(2);
  expect(prepared.handoff.delegation).toMatchObject({
    reviewer: { harness: "codex", model: config.model },
    payload: { projectEvidence: true, images: true },
    preparedPayload: {
      packetPath: prepared.handoff.packetPath,
      packetBytes: expect.any(Number),
      imageCount: 2,
      imageBytes: 2,
    },
  });
  expect(
    prepared.mutations.filter((m) => m.kind === "write" && m.content instanceof Uint8Array),
  ).toHaveLength(2);
  const packetMutation = prepared.mutations.find(
    (mutation) => mutation.path === prepared.handoff.packetPath,
  );
  expect(JSON.stringify(packetMutation)).not.toContain("YQ==");
  expect(JSON.stringify(packetMutation)).toContain("imagePath");
  expect(
    nativeCapabilityGaps(
      config,
      { ...capabilities, harness: "codex", reasoningEffort: "high", images: false },
      true,
    ),
  ).toEqual([expect.stringContaining("images")]);
  for (const harness of CRITIC_HARNESSES)
    expect(balancedCritic(harness)).toMatchObject({
      harness,
      maxCalls: 3,
      reasoningEffort: "high",
    });
});

it("reads legacy product attempts and old limit fields without rewriting history or resetting calls", async () => {
  await ready();
  const p = await prepare();
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: p.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(p.packet),
      },
    }),
  ).toMatchObject({ ok: true });
  const selected = await criticSelection(await setup.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const historical = JSON.parse(await readFile(selected.value.path, "utf8"));
  for (const attempt of historical.attempts) delete attempt.phase;
  historical.config.maxOutputTokens = 4096;
  historical.config.maxInputCharacters = 60000;
  const bytes = JSON.stringify(historical);
  await writeFile(selected.value.path, bytes);
  const status = await run({ operation: "status" });
  expect(status).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 1, next: "normal-acceptance" },
  });
  expect(status.ok && JSON.stringify(status.value)).not.toContain("maxOutputTokens");
  expect(status.ok && JSON.stringify(status.value)).not.toContain("maxInputCharacters");
  expect(await readFile(selected.value.path, "utf8")).toBe(bytes);
});

it("keeps long native packets and image paths without a character ceiling, and deduplicates media", () => {
  const image = { data: "YQ==", mimeType: "image/jpeg" };
  const packet = {
    text: "x".repeat(90000),
    current: { images: [image, image, { ...image, mimeType: "image/webp" }] },
  } as unknown as CriticPacket;
  expect(nativePacket(packet, `/tmp/${"long/".repeat(30)}`, config)).toMatchObject({ ok: true });
  const small = nativePacket(
    { current: { images: [image, image] } } as unknown as CriticPacket,
    "/tmp/packet",
    { ...config, maxImageBytes: 1 },
  );
  expect(small).toMatchObject({
    ok: true,
    value: { handoff: { images: [expect.objectContaining({ mimeType: "image/jpeg" })] } },
  });
});

it("keeps unavailable preflight and malformed state read-only across native operations", async () => {
  expect(await run({ operation: "preflight" })).toMatchObject({
    ok: true,
    value: { ready: false },
  });
  await run({ operation: "configure", config });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, gaps: [expect.stringContaining("usable slice")] },
  });
  const result = {
    attempt: "00000000-0000-4000-8000-000000000000",
    model: config.model,
    context: "unavailable",
    failure: "Cannot dispatch",
  };
  for (const operation of ["preflight", "prepare", "submit"]) {
    expect(
      await run({
        operation,
        task: "T404",
        ...(operation === "submit" ? { result } : { capabilities }),
      }),
    ).toMatchObject({ ok: false });
  }
  expect(await run({ operation: "submit", result })).toMatchObject({ ok: false });
  const dir = join(setup.workspace.root, ".visp/features", setup.brief.feature, "critic");
  const files = await readdir(dir);
  const path = join(
    ".visp/features",
    setup.brief.feature,
    "critic",
    files.find((f) => f.endsWith(".json")) ?? "missing",
  );
  await setup.workspace.write(path, "not valid JSON");
  for (const operation of ["preflight", "prepare", "submit"]) {
    expect(
      await run({ operation, ...(operation === "submit" ? { result } : { capabilities }) }),
    ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  }
});

it("preflight refuses an exhausted budget without loading unrelated historical candidate bytes", async () => {
  await ready({ ...config, maxCalls: 1 });
  const p = await prepare();
  await run({
    operation: "submit",
    result: {
      attempt: p.attempt,
      model: config.model,
      reasoningEffort: "high",
      context: "fresh",
      response: answer(p.packet),
    },
  });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, callsUsed: 1, gaps: [expect.stringContaining("budget exhausted")] },
  });
  const status = await run({ operation: "status" });
  if (!status.ok) throw new Error(status.error.message);
  const candidates = (status.value as { candidates: { path: string }[] }).candidates;
  const candidate = candidates[0];
  if (!candidate) throw new Error("candidate");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(candidate.path, "corrupted historical record");
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, callsUsed: 1 },
  });
});

it("accepts an actual host effort when configuration deliberately leaves effort unspecified", async () => {
  await ready({ ...config, reasoningEffort: undefined });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true },
  });
  const p = await prepare();
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: p.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(p.packet),
      },
    }),
  ).toMatchObject({ ok: true, value: { action: "normal-acceptance" } });
});

it("accepts an unchanged raw critic response with explicit host facts and generated attempt identity", async () => {
  await ready();
  const prepared = await prepare();
  const response = answer(prepared.packet);
  expect(
    await run({ operation: "submit", attempt: prepared.attempt, response, capabilities }),
  ).toMatchObject({
    ok: true,
    value: { action: "normal-acceptance", callsUsed: 1 },
  });
  expect(
    await run({ operation: "submit", attempt: prepared.attempt, response, capabilities }),
  ).toMatchObject({ ok: false });
});

it("creates an unobserved host-report file and executes the exact prepared submission after host observation", async () => {
  await ready();
  const result = await run({ operation: "prepare", capabilities });
  if (!result.ok) throw new Error(result.error.message);
  const prepared = result.value as {
    attempt: string;
    packetPath: string;
    responsePath: string;
    capabilitiesPath: string;
    capabilitiesStatus: string;
    submission: { args: string[] };
  };
  expect(prepared.capabilitiesStatus).toBe("unobserved");
  const unobserved = JSON.parse(await readFile(prepared.capabilitiesPath, "utf8"));
  expect(unobserved).toMatchObject({ model: null, freshContext: null, readOnly: null });
  expect(JSON.stringify(unobserved)).not.toContain(config.model);
  const packet = JSON.parse(await readFile(prepared.packetPath, "utf8")) as CriticPacket;
  const raw = JSON.stringify(answer(packet));
  await writeFile(prepared.responsePath, raw);
  const incomplete = await runJson(setup.workspace.root, ...prepared.submission.args);
  expect(incomplete.envelope).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("missing or invalid observations: harness, model"),
    },
  });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, stopped: "review-in-progress" },
  });
  // The offline host supplies its observed session facts, not VISP's requested settings.
  await writeFile(prepared.capabilitiesPath, JSON.stringify(capabilities));
  const submitted = await runJson(setup.workspace.root, ...prepared.submission.args);
  expect(submitted.envelope).toMatchObject({
    ok: true,
    data: { callsUsed: 1, action: "normal-acceptance", lifecycle: { provenance: "host-reported" } },
  });
  expect(await readFile(prepared.responsePath, "utf8")).toBe(raw);
});

it("keeps malformed native output unchanged and pending, with recovery instead of judgment rewriting", async () => {
  await ready();
  const prepared = await prepare();
  const responsePath = join(prepared.packetPath, "..", "response.json");
  const capabilitiesPath = join(prepared.packetPath, "..", "capabilities.json");
  const raw = `${JSON.stringify(answer(prepared.packet))}}`;
  await writeFile(responsePath, raw);
  await writeFile(capabilitiesPath, JSON.stringify(capabilities));
  const result = await runJson(
    setup.workspace.root,
    "critic",
    "--attempt",
    prepared.attempt,
    "--capabilities",
    capabilitiesPath,
    "--submit",
    responsePath,
  );
  expect(result.envelope).toMatchObject({
    ok: false,
    error: {
      message: expect.stringContaining("do not relaunch the critic or rewrite its judgments"),
    },
  });
  expect(await readFile(responsePath, "utf8")).toBe(raw);
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, stopped: "review-in-progress" },
  });
});

it("does not advertise an early-understanding escape when product preflight is unavailable", async () => {
  await ready();
  const result = await run({
    operation: "preflight",
    capabilities: { ...capabilities, images: false, readOnly: false },
  });
  expect(result).toMatchObject({
    ok: true,
    value: {
      phase: "product",
      ready: false,
      hostSetup: {
        recovery: expect.stringContaining("Continue baseline host review"),
        retry: expect.stringContaining("--phase product --preflight"),
      },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  expect((result.value as { hostSetup: object }).hostSetup).not.toHaveProperty("reportUnavailable");
});

it("requires product evidence from the selected slice before native preflight or preparation", async () => {
  const amended = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      outcomes: [
        ...setup.brief.outcomes,
        {
          id: "O002",
          kind: "functional",
          statement: "The second module returns three",
          priority: "must",
          provenance: "agent-proposed",
        },
      ],
      checks: [
        ...setup.brief.checks,
        {
          id: "C002",
          command: [
            process.execPath,
            "--input-type=module",
            "-e",
            "import {value} from './src/other.mjs'; if(value !== 3) process.exit(1)",
          ],
          outcomes: ["O002"],
          files: ["src/other.mjs"],
          environment: "node",
        },
      ],
      slices: [
        ...setup.brief.slices,
        {
          id: "T002",
          goal: "Implement the second module",
          outcomes: ["O002"],
          scope: { allowed: ["src/other.mjs"], expected: ["src/other.mjs"], forbidden: [] },
          checks: ["C002"],
        },
      ],
    },
    reason: "Add an independent slice to exercise review selection",
  });
  expect(amended.ok).toBe(true);
  await ready();
  expect(await run({ operation: "configure", task: "T002", config })).toMatchObject({ ok: true });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true },
  });
  expect(await run({ operation: "preflight", task: "T002", capabilities })).toMatchObject({
    ok: true,
    value: {
      ready: false,
      callsUsed: 0,
      gaps: [expect.stringContaining("Recorded evidence exists")],
    },
  });
  expect(await run({ operation: "prepare", task: "T002", capabilities })).toMatchObject({
    ok: false,
    error: { code: "EVIDENCE_MISSING" },
  });
  expect((await runProductWork(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  await setup.workspace.write("src/other.mjs", "export const value = 3;\n");
  expect((await runProductVerify(await setup.workspace.state(), { task: "T002" })).ok).toBe(true);
  expect(await run({ operation: "preflight", task: "T002", capabilities })).toMatchObject({
    ok: true,
    value: { ready: true, callsUsed: 0 },
  });
  expect(await run({ operation: "prepare", task: "T002", capabilities })).toMatchObject({
    ok: true,
  });
});

it("accepts an adapter response received before the deadline despite slow local validation", async () => {
  await ready({ ...config, timeoutMs: 5000 });
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const originalDigest = productSubject.productSourceDigest;
  let returned = false;
  vi.spyOn(productSubject, "productSourceDigest").mockImplementation(async (...args) => {
    if (returned) clock += 5001;
    return originalDigest(...args);
  });
  const result = await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    {
      inspect: async () =>
        capabilities as NonNullable<
          import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
        >,
      review: async (packet) => {
        returned = true;
        return {
          model: config.model,
          reasoningEffort: "high",
          context: "fresh",
          response: answer(packet),
        };
      },
    },
  );
  expect(result).toMatchObject({
    ok: true,
    value: { callsUsed: 1, lifecycle: { acceptedReview: true, provenance: "adapter-observed" } },
  });
});

it("does not accept a native caller's timestamp as adapter-observed completion", async () => {
  await ready();
  const prepared = await prepare();
  vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt + 1);
  expect(
    await run({
      operation: "submit",
      result: {
        attempt: prepared.attempt,
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: answer(prepared.packet),
        returnedAt: prepared.expiresAt - 1,
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      capabilities,
      response: answer(prepared.packet),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      action: "unresolved",
      reason: expect.stringContaining("deadline expired"),
    },
  });
});

it("preserves an adapter's rejected response object for diagnosis without accepting it", async () => {
  await ready();
  const raw = { incomplete: "The reviewer did not use the response shape" };
  const result = await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    {
      inspect: async () =>
        capabilities as NonNullable<
          import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
        >,
      review: async () => ({
        model: config.model,
        reasoningEffort: "high",
        context: "fresh",
        response: raw,
      }),
    },
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      action: "unresolved",
      responseRecord: { provenance: expect.stringContaining("Adapter-returned object") },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  const saved = (result.value as { responseRecord: { path: string } }).responseRecord.path;
  expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(raw);
});

it("preserves the historical candidate without priming the independent reviewer", async () => {
  await ready();
  const { readProductRecord } = await import("../../../../src/workflow/product/store.js");
  const initial = await readProductRecord(await setup.workspace.state());
  if (!initial.ok) throw new Error(initial.error.message);
  const checkpoint = initial.value.state.checkpoints?.[0];
  expect(checkpoint).toBeDefined();
  const path = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "candidates",
    `${checkpoint?.candidate}.json`,
  );
  const original = await readFile(path, "utf8");
  await setup.workspace.write(
    "src/value.mjs",
    "// rendering correction with the same public behavior\nexport const value = 2;\n",
  );
  await runProductVerify(await setup.workspace.state(), { task: "T001" });
  expect(await readFile(path, "utf8")).toBe(original);
  const prepared = await prepare();
  expect(prepared.packet).not.toHaveProperty("previous");
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      capabilities,
      response: answer(prepared.packet),
    }),
  ).toMatchObject({
    ok: true,
    value: {
      action: "normal-acceptance",
      gaps: [],
    },
  });
});

it("rejects raw submission with unobserved read-only host capability without accepting the product", async () => {
  await ready();
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      capabilities: { ...capabilities, readOnly: false },
      response: answer(prepared.packet),
    }),
  ).toMatchObject({
    ok: true,
    value: { action: "unresolved", reason: expect.stringContaining("no source-editing") },
  });
});

it("provides an explicit Codex effort and confined response path, and records dispatch failure without a fake review", async () => {
  await ready();
  const p = await run({ operation: "prepare", capabilities });
  expect(p).toMatchObject({
    ok: true,
    value: {
      codexCli: {
        executable: "codex",
        args: expect.arrayContaining([
          "--config",
          'model_reasoning_effort="high"',
          "--sandbox",
          "read-only",
        ]),
      },
      submission: { failureCommand: expect.stringContaining("--failure") },
    },
  });
  if (!p.ok) throw new Error(p.error.message);
  const prepared = p.value as {
    attempt: string;
    responsePath: string;
    codexCli: { args: string[]; stdinFile: string };
    packetPath: string;
  };
  expect(prepared.responsePath.startsWith(join(setup.workspace.root, ".visp/features"))).toBe(true);
  expect(prepared.codexCli.args).toContain(prepared.responsePath);
  expect(prepared.codexCli.stdinFile).toBe(prepared.packetPath);
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      failure: "Host refused delegation",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      next: "unresolved",
      stopped: expect.stringContaining("Host refused delegation"),
    },
  });
});

it("rejects a raw response from the worker context instead of claiming an independent review", async () => {
  await ready();
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      response: answer(prepared.packet),
      capabilities: { ...capabilities, freshContext: false },
    }),
  ).toMatchObject({
    ok: true,
    value: { callsUsed: 1, next: "unresolved", stopped: expect.stringContaining("fresh reviewer") },
  });
});

it("keeps a product reservation pending when a submission incorrectly names the understanding phase", async () => {
  await ready();
  const prepared = await prepare();
  expect(
    await run({
      operation: "submit",
      phase: "understanding",
      attempt: prepared.attempt,
      response: answer(prepared.packet),
      capabilities,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("phase differs") },
  });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, stopped: "review-in-progress" },
  });
  expect(
    await run({
      operation: "submit",
      attempt: prepared.attempt,
      failure: "Host cancelled",
      capabilities,
    }),
  ).toMatchObject({
    ok: true,
    value: { callsUsed: 1, stopped: expect.stringContaining("Host cancelled") },
  });
});

it("reports feature opt-out in preflight without reserving a reviewer", async () => {
  await ready();
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "set-policy",
      enabled: false,
      reason: "User opted out for this test",
    }),
  ).toMatchObject({ ok: true });
  expect(await run({ operation: "preflight", capabilities })).toMatchObject({
    ok: true,
    value: { ready: false, enabled: false, gaps: [expect.stringContaining("critic is off")] },
  });
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({ ok: false });
});

it("propagates cancellation after one invocation and never retries the interrupted attempt", async () => {
  await ready();
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let hostSignal: AbortSignal | undefined;
  const host = {
    inspect: async () =>
      capabilities as NonNullable<
        import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
      >,
    review: vi.fn(
      async (_packet: CriticPacket, options: { signal: AbortSignal }): Promise<never> => {
        hostSignal = options.signal;
        started();
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("Cancelled by caller")), {
            once: true,
          }),
        );
      },
    ),
  };
  const dispatched = runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
    controller.signal,
  );
  await entered;
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
  await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
  );
  expect(host.review).toHaveBeenCalledTimes(1);
  const selected = await criticSelection(await setup.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const stored = await readCriticState(await setup.workspace.state(), selected.value);
  if (!stored.ok) throw new Error(stored.error.message);
  const pending = stored.value.state?.attempts.find((attempt) => attempt.status === "pending");
  expect(
    await run({
      operation: "submit",
      attempt: pending?.id,
      capabilities,
      response: { review: { assessments: [] } },
    }),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining("cannot impersonate") } });
  controller.abort();
  expect(await dispatched).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      lifecycle: { acceptedReview: false, returned: false, status: "invocation-failed" },
    },
  });
  expect(hostSignal?.aborted).toBe(true);
});

it("does not reserve or inspect after caller cancellation", async () => {
  await ready();
  const controller = new AbortController();
  controller.abort();
  const host = { inspect: vi.fn(), review: vi.fn() };
  expect(
    await runProductCritic(
      await setup.workspace.state(),
      { operation: "review", task: "T001" },
      host,
      controller.signal,
    ),
  ).toMatchObject({ ok: false });
  expect(host.inspect).not.toHaveBeenCalled();
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 0 } });
});

it.each(["cli", "mcp"])(
  "dispatches one attached adapter through the %s interface",
  async (surface) => {
    await ready();
    const host = {
      inspect: async () =>
        capabilities as NonNullable<
          import("../../../../src/workflow/product/critic-model.js").CriticRequest["capabilities"]
        >,
      review: vi.fn(async (packet: CriticPacket) => ({
        model: config.model,
        reasoningEffort: "high" as const,
        context: "fresh" as const,
        response: answer(packet),
      })),
    };
    if (surface === "mcp") {
      let handler:
        | ((args: unknown, extra: { signal: AbortSignal }) => Promise<unknown>)
        | undefined;
      const server = {
        registerTool(_name: string, _config: unknown, callback: typeof handler) {
          handler = callback;
        },
      } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
      const { registerCriticTool } = await import("../../../../src/mcp/tools/critic.js");
      registerCriticTool(server, setup.workspace.root, server, host);
      expect(handler).toBeDefined();
      const result = await handler?.(
        { operation: "review", task: "T001" },
        { signal: new AbortController().signal },
      );
      expect(result).toMatchObject({
        structuredContent: { data: { callsUsed: 1, lifecycle: { acceptedReview: true } } },
      });
    } else {
      const { buildProgram } = await import("../../../../src/cli/program.js");
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const previous = process.exitCode;
      try {
        await buildProgram({ criticHost: host }).parseAsync([
          "node",
          "visp",
          "--project",
          setup.workspace.root,
          "critic",
          "--task",
          "T001",
          "--dispatch",
          "--json",
        ]);
        expect(process.exitCode).toBe(0);
      } finally {
        output.mockRestore();
        process.exitCode = previous;
      }
    }
    expect(host.review).toHaveBeenCalledOnce();
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { callsUsed: 1, lifecycle: { acceptedReview: true, provenance: "adapter-observed" } },
    });
  },
);

it("recovers through an attached adapter once, preserving its observed invocation ownership", async () => {
  await ready();
  const host = {
    inspect: vi.fn(async () => ({
      ...capabilities,
      harness: "codex" as const,
      reasoningEffort: "high" as const,
      delegationAllowed: true,
    })),
    review: vi.fn(async (packet: CriticPacket) => ({
      model: config.model,
      reasoningEffort: "high" as const,
      context: "fresh" as const,
      response: answer(packet),
    })),
  };
  host.review.mockRejectedValueOnce(new Error("Provider rejected response schema"));
  const failed = await runProductCritic(
    await setup.workspace.state(),
    { task: "T001", operation: "review" },
    host,
  );
  expect(failed).toMatchObject({
    ok: true,
    value: { callsUsed: 1, lifecycle: { acceptedReview: false } },
  });
  if (!failed.ok) throw new Error(failed.error.message);
  const after = (failed.value as { recovery: { after: string } }).recovery.after;
  expect(
    await run({ operation: "submit", attempt: after, failure: "No invocation", notInvoked: true }),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining("claimed invocation") } });
  const request = {
    task: "T001",
    operation: "review",
    retryAfter: after,
    reason: "Provider schema corrected; existing authorization covers the fresh attempt",
  };
  expect(await runProductCritic(await setup.workspace.state(), request, host)).toMatchObject({
    ok: true,
    value: { callsUsed: 2, lifecycle: { acceptedReview: true, provenance: "adapter-observed" } },
  });
  expect(await runProductCritic(await setup.workspace.state(), request, host)).toMatchObject({
    ok: false,
  });
  expect(host.review).toHaveBeenCalledTimes(2);
});
