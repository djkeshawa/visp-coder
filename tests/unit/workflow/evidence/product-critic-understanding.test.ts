import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import * as probe from "../../../../src/testing/browser-capability.js";
import { type CriticPacket, runProductCritic } from "../../../../src/workflow/product/critic.js";
import { criticUnderstanding } from "../../../../src/workflow/product/critic-understanding.js";
import { outstandingFeedback } from "../../../../src/workflow/product/feedback.js";
import {
  runProductAccept,
  runProductContext,
  runProductDone,
  runProductNext,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import { readProductAuthorization } from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { legacyReview } from "../../support/legacy-critic.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const config = { ...needed(balancedCritic("codex")), maxCalls: 2 };
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  readOnly: true,
  images: false,
  delegationAllowed: true,
};
function needed<T>(input: T | undefined): T {
  if (input === undefined) throw new Error("Expected fixture value");
  return input;
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const run = async (input: object) =>
  runProductCritic(await setup.workspace.state(), { task: "T001", ...input });
const configure = (overrides: object = {}) =>
  run({ operation: "configure", config: { ...config, ...overrides } });
const record = async () => value(await readProductRecord(await setup.workspace.state()));
async function prepare(phase: "understanding" | "product" = "understanding") {
  const result = value(await run({ operation: "prepare", phase, capabilities })) as {
    attempt: string;
    packetPath: string;
    expiresAt: number;
  };
  return {
    ...result,
    packet: JSON.parse(await readFile(result.packetPath, "utf8")) as CriticPacket,
  };
}
function answer(packet: CriticPacket) {
  const source = needed(packet.current.sources.find((entry) => entry.kind === "authored-brief")).id;
  return {
    review: {
      ...legacyReview(packet),
      feedback: {
        ...legacyReview(packet).feedback,
        phase: "understanding" as const,
        dimensions: legacyReview(packet).feedback.dimensions.map((entry) => ({
          ...entry,
          status: "satisfied" as const,
          reason:
            "The proposed behavior and design address the stated goal; implementation remains unobserved",
          evidence: [source],
        })),
      },
    },
    comparison: [],
  };
}
const submit = (attempt: string, response: unknown, extra: object = {}) =>
  run({
    operation: "submit",
    result: {
      attempt,
      model: config.model,
      reasoningEffort: "high",
      context: "fresh",
      response,
      ...extra,
    },
  });
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await setup.workspace.destroy();
});

it("offers optional design consultation while ordinary work authorizes source edits", async () => {
  value(await configure());
  const directory = join(setup.workspace.root, ".visp/features", setup.brief.feature, "critic");
  const before = await readdir(directory);
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: {
      action: "implement",
      command: expect.stringContaining("visp work"),
    },
  });
  expect(await run({ operation: "preflight", phase: "understanding", capabilities })).toMatchObject(
    { ok: true, value: { ready: true, callsUsed: 0, requiresImages: false } },
  );
  expect(await readdir(directory)).toEqual(before);
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  expect(
    value(await readProductAuthorization(await setup.workspace.state(), await record())),
  ).toBeDefined();
  expect(
    await run({
      operation: "prepare",
      phase: "understanding",
      capabilities: { ...capabilities, model: "other" },
    }),
  ).toMatchObject({ ok: false });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 0 } });
});

it("delivers full proposed UI/technical design without requiring images of an unbuilt product or limiting text", async () => {
  const brief = {
    ...setup.brief,
    outcomes: [
      ...setup.brief.outcomes,
      {
        id: "O002",
        kind: "experience" as const,
        statement: "The primary playfield is usable on desktop and mobile",
        priority: "must" as const,
        provenance: "agent-proposed" as const,
        expectations: [],
        reviewRequired: true,
      },
    ],
    slices: setup.brief.slices.map((slice) => ({
      ...slice,
      outcomes: [...slice.outcomes, "O002"],
    })),
    decisions: [
      {
        id: "D001",
        statement: "Keep the playfield dominant and separate physics from rendering",
        rationale: "A small playfield would impair aiming",
        evidence: ["User requested a playable game"],
        implications: ["Use a compact HUD, pointer input and responsive canvas"],
        outcomes: ["O001"],
      },
    ],
  };
  // Long design text is intentionally valid: VISP does not impose a character ceiling.
  needed(brief.decisions[0]).rationale = "Design rationale ".repeat(6000);
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief,
      reason: "Specify the approach",
    }),
  );
  value(await configure({}));
  const prepared = await prepare();
  expect(prepared.packet.design?.brief.decisions[0]?.rationale).toBe(brief.decisions[0]?.rationale);
  expect(JSON.stringify(prepared.packet).length).toBeGreaterThan(80000);
  expect(prepared.packet.instructions).toContain("original request");
  expect(prepared.packet.responseSchema).toHaveProperty("properties");
  expect(legacyReview(prepared.packet).assessments).toEqual([]);
  expect(prepared.packet.current.images).toEqual([]);
  const response = answer(prepared.packet);
  needed(response.review.feedback.dimensions[0]).reason = "Detailed design reasoning ".repeat(4000);
  expect(await submit(prepared.attempt, response, { outputTokens: 40000 })).toMatchObject({
    ok: true,
    value: { action: "worker", callsUsed: 1, callsRemaining: 1, phase: "understanding" },
  });
  expect(await run({ operation: "status", phase: "understanding" })).toMatchObject({
    ok: true,
    value: { next: "worker", command: expect.stringContaining("visp work") },
  });
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { action: "implement", command: expect.stringContaining("visp work") },
  });
  const current = await record();
  expect(current.state.executions).toEqual([]);
  expect(current.state.reviews.at(-1)?.assessments).toEqual([]);
  expect(current.state.reviews.at(-1)?.feedback?.phase).toBe("understanding");
  expect(await run({ operation: "prepare", phase: "understanding", capabilities })).toMatchObject({
    ok: false,
  });
});

it("hands negative design feedback to the worker, preserves it through method changes and retains the product call", async () => {
  value(await configure());
  const prepared = await prepare();
  const response = answer(prepared.packet);
  response.review.feedback.findings.push({
    dimension: "experience",
    problem: "Proposed interaction hides the primary action",
    nextCheck: "Give the primary action a stable visible target",
    required: true,
    outcomes: ["O001"],
    evidence: [
      needed(prepared.packet.current.sources.find((entry) => entry.kind === "authored-brief")).id,
    ],
  });
  value(await submit(prepared.attempt, response));
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { action: "implement" },
  });
  const updated = value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        uncertainties: ["Measure the ordinary input target in the first rendered slice"],
      },
      reason: "Address the critic's interaction concern",
    }),
  );
  expect(updated.outcomes).toEqual(setup.brief.outcomes);
  expect(outstandingFeedback(await record())).toHaveLength(1);
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: {
      mayEdit: true,
      criticUnderstanding: {
        status: "reviewed",
        findings: [expect.objectContaining({ required: true })],
      },
    },
  });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 1, next: "review" },
  });
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(
    value(await runProductVerify(await setup.workspace.state(), { task: "T001" })).passed,
  ).toBe(true);
  const product = await prepare("product");
  expect((product.packet as unknown as { previous?: unknown }).previous).toBeUndefined(); // An unbuilt design is not a product comparison baseline.
  const reviewed = {
    review: {
      ...legacyReview(product.packet),
      feedback: moduleFeedback(product.packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  };
  expect(await submit(product.attempt, reviewed)).toMatchObject({
    ok: true,
    value: { action: "worker", callsUsed: 2, callsRemaining: 0 },
  });
  expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: false },
  });
  expect(await run({ operation: "prepare", capabilities })).toMatchObject({ ok: false });
});

it.each(["product-phase", "assessments", "coverage", "comparison", "resolutions"])(
  "rejects %s product credit in an early consultation",
  async (kind) => {
    value(await configure());
    const prepared = await prepare();
    const response = answer(prepared.packet) as {
      review: Record<string, unknown> & { feedback: Record<string, unknown> };
      comparison: unknown[];
    };
    if (kind === "product-phase") response.review.feedback.phase = "product";
    if (kind === "assessments")
      response.review.assessments = [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "A plan proves success",
          evidence: [],
          expectations: [],
          provenance: "agent-reported",
        },
      ];
    if (kind === "coverage")
      response.review.coverage = [
        { id: "invented", status: "satisfied", reason: "A plan proves success", evidence: [] },
      ];
    if (kind === "comparison")
      response.comparison = [{ dimension: "functional", change: "better", reason: "unbuilt" }];
    if (kind === "resolutions")
      response.review.feedback.resolutions = [
        { id: "invented", explanation: "A plan proves the fix", evidence: ["SRC-REQUEST"] },
      ];
    expect(await submit(prepared.attempt, response)).toMatchObject({
      ok: true,
      value: { action: "worker", callsUsed: 1, reason: expect.any(String) },
    });
    expect((await record()).state.reviews).toEqual([]);
    expect(await run({ operation: "status" })).toMatchObject({
      ok: true,
      value: { next: "review", callsRemaining: 1 },
    });
  },
);

it("keeps invocation exclusive while pausing implementation and retaining spent calls", async () => {
  value(await configure());
  const prepared = await prepare();
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: false,
    error: { code: "STATE_BUSY", message: expect.stringContaining("review is pending") },
  });
  expect(await runProductContext(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
  });
  expect(await run({ operation: "set-policy", task: undefined, enabled: false })).toMatchObject({
    ok: false,
  });
  vi.spyOn(Date, "now").mockReturnValue(prepared.expiresAt + 1);
  expect(await criticUnderstanding(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { requiredBeforeWork: false, status: "unavailable", callsRemaining: 1 },
  });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { next: "review", callsUsed: 1 },
  });
  expect(await submit(prepared.attempt, answer(prepared.packet))).toMatchObject({
    ok: true,
    value: { action: "worker", reason: expect.stringContaining("deadline") },
  });
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
});

it("discards a design response if the supplied uncertainties change while the reviewer is working", async () => {
  value(await configure());
  const prepared = await prepare();
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        uncertainties: ["A newly supplied interaction constraint changes the design question"],
      },
      reason: "Preserve new design information",
    }),
  );
  expect(await submit(prepared.attempt, answer(prepared.packet))).toMatchObject({
    ok: true,
    value: { action: "worker", reason: expect.stringContaining("contract changed"), callsUsed: 1 },
  });
  expect((await record()).state.reviews).toEqual([]);
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsRemaining: 1, next: "review" },
  });
});

it("closes a correct implemented slice after its second call without using the design as a product baseline", async () => {
  value(await configure());
  const design = await prepare();
  value(await submit(design.attempt, answer(design.packet)));
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductVerify(await setup.workspace.state(), { task: "T001" }));
  const product = await prepare("product");
  const response = {
    review: {
      ...legacyReview(product.packet),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The public module returned two under an actual Node test",
          evidence: ["C001"],
          expectations: [],
        },
      ],
      feedback: moduleFeedback(product.packet.current as unknown as ProductReviewBundle),
    },
    comparison: [],
  };
  expect(await submit(product.attempt, response)).toMatchObject({
    ok: true,
    value: {
      action: "normal-acceptance",
      callsUsed: 2,
      preferredCandidate: expect.any(String),
      assessmentCurrent: true,
      reviewCapacity: {
        limit: 2,
        understandingCalls: 1,
        productCalls: 1,
        remainingCalls: 0,
        canReviewAndRecheck: false,
      },
    },
  });
  expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
});

it("accepts focused advice without category declarations and preserves findings and image limits", async () => {
  value(await configure());
  const prepared = await prepare();
  const response = answer(prepared.packet);
  response.review.feedback.dimensions = [];
  expect(await submit(prepared.attempt, response)).toMatchObject({
    ok: true,
    value: { action: "worker", callsUsed: 1 },
  });
  const { criticResponseSchema } = await import("../../../../src/workflow/product/critic-model.js");
  const finding = {
    dimension: "experience",
    problem: "Inspect an actual mismatch",
    nextCheck: "Check the input",
    outcomes: [],
    evidence: [],
    required: false,
  };
  expect(
    criticResponseSchema.safeParse({
      ...response,
      review: {
        ...response.review,
        feedback: { ...response.review.feedback, findings: Array(4).fill(finding) },
      },
    }).success,
  ).toBe(false);
  const { nativePacket } = await import("../../../../src/workflow/product/critic-native.js");
  expect(
    nativePacket(
      {
        current: {
          images: [{ data: Buffer.alloc(1025).toString("base64"), mimeType: "image/png" }],
        },
      } as unknown as CriticPacket,
      "/tmp/critic-image-limit",
      { ...config, maxImageBytes: 1024 },
    ),
  ).toMatchObject({ ok: false });
});

it("reserves a one-call budget for product review and preserves critic opt-out", async () => {
  value(await configure({ maxCalls: 1 }));
  expect(await run({ operation: "prepare", phase: "understanding", capabilities })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("remaining critic call") },
  });
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  expect(await run({ operation: "preflight", phase: "understanding", capabilities })).toMatchObject(
    {
      ok: true,
      value: {
        ready: false,
        gaps: expect.arrayContaining([expect.stringContaining("before slice implementation")]),
      },
    },
  );
  value(await run({ operation: "set-policy", task: undefined, enabled: false }));
  expect(await criticUnderstanding(await setup.workspace.state(), { task: "T001" })).toEqual({
    ok: true,
    value: undefined,
  });
});

it("permits scoped implementation through a browser gap without inventing design approval", async () => {
  const browser = vi
    .spyOn(probe, "probeBrowserCapability")
    .mockRejectedValue(new Error("Browser unavailable: permission denied"));
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        checks: [
          ...setup.brief.checks,
          {
            id: "C002",
            command: {
              kind: "browser-journey",
              journey: {
                url: "http://127.0.0.1:8123",
                actions: [{ kind: "click", selector: "button" }],
              },
            },
            outcomes: ["O001"],
            files: ["src/value.mjs"],
            environment: "browser",
          },
        ],
        slices: setup.brief.slices.map((slice) => ({
          ...slice,
          checks: [...slice.checks, "C002"],
        })),
      },
      reason: "Observe real browser input",
    }),
  );
  value(await configure());
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: {
      command: expect.stringContaining("--retry-environment"),
      mayEdit: true,
      criticAdvice: {
        command: expect.stringContaining("--retry-environment"),
        guidance: expect.stringContaining("Keep critic capacity for the rendered product"),
      },
    },
  });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 0 } });
  browser.mockResolvedValue();
  expect(
    await runProductWork(await setup.workspace.state(), { task: "T001", retryEnvironment: true }),
  ).toMatchObject({
    ok: true,
    value: { mayEdit: true },
  });
  expect((await record()).state.browserCapability?.status).toBe("ready");
  expect(
    value(await readProductAuthorization(await setup.workspace.state(), await record())),
  ).toBeDefined();
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { command: expect.stringContaining("visp done") },
  });
  expect(browser).toHaveBeenCalledTimes(2);
});

it("allows a design correction with new brief evidence while keeping product acceptance unresolved", async () => {
  value(await configure());
  const prepared = await prepare();
  const response = answer(prepared.packet);
  response.review.feedback.findings.push({
    dimension: "experience",
    problem: "Unclear input design",
    nextCheck: "Specify the input target",
    required: true,
    outcomes: ["O001"],
    evidence: [
      needed(prepared.packet.current.sources.find((entry) => entry.kind === "authored-brief")).id,
    ],
  });
  value(await submit(prepared.attempt, response));
  const finding = needed(outstandingFeedback(await record())[0]);
  const template = value(
    await runProductReviewRequest(await setup.workspace.state(), { task: "T001", template: true }),
  ) as ReturnType<typeof legacyReview>;
  const resolve = (submission: typeof template, evidence: string[]) =>
    runProductReviewRequest(setupState, {
      task: "T001",
      ...submission,
      assessments: [],
      coverage: [],
      feedback: {
        phase: "understanding",
        dimensions: [],
        findings: [],
        resolutions: [
          {
            id: finding.id,
            explanation: "The revised design exposes a stable input target",
            evidence,
          },
        ],
      },
    });
  const setupState = await setup.workspace.state();
  expect(await resolve(template, finding.evidence)).toMatchObject({ ok: true });
  expect(outstandingFeedback(await record()).some((entry) => entry.id === finding.id)).toBe(true);
  expect((await record()).state.reviews.at(-1)?.feedback?.resolutions).toEqual([]);
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        uncertainties: ["Check the revised visible input target in the first slice"],
      },
      reason: "Revise input design",
    }),
  );
  const handoff = value(
    await runProductReviewRequest(await setup.workspace.state(), { task: "T001", handoff: true }),
  ) as CriticPacket["current"] & { submission: typeof template };
  const newSource = needed(handoff.sources.find((entry) => entry.kind === "authored-brief")).id;
  expect(newSource).not.toBe(finding.evidence[0]);
  expect(await resolve(handoff.submission, [newSource])).toMatchObject({ ok: true });
  expect(outstandingFeedback(await record())).toEqual([]);
});

it("keeps the final call after validated example revisions and never treats old design evidence as current", async () => {
  setup.brief = value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        examples: [
          {
            id: "X001",
            title: "Read the value",
            given: [],
            when: "Read the module",
            expected: ["The value is two"],
            outcomes: ["O001"],
          },
        ],
      },
      reason: "Specify observable behavior",
    }),
  );
  value(await configure());
  const design = await prepare();
  value(await submit(design.attempt, answer(design.packet)));
  const revised = {
    ...setup.brief,
    examples: setup.brief.examples.map((example) => ({
      ...example,
      when: `${example.when} using the public entry point`,
    })),
  };
  expect(
    await updateProductBrief(await setup.workspace.state(), {
      brief: revised,
      reason: "Correct the example",
    }),
  ).toMatchObject({ ok: false });
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: revised,
      intentChange: {
        reason: "Apply the early review's clarification",
        provenance: "agent-reported clarification; not independent approval",
      },
    }),
  );
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 1, next: "review" },
  });
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductVerify(await setup.workspace.state(), { task: "T001" }));
  const product = await prepare("product");
  expect((product.packet as unknown as { previous?: unknown }).previous).toBeUndefined();
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 2, callsRemaining: 0 },
  });
  expect((await record()).state.reviews).toHaveLength(1);
  value(
    await submit(product.attempt, {
      review: {
        ...legacyReview(product.packet),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "Actual public module test returned two",
            evidence: ["C001"],
            expectations: [],
          },
        ],
        coverage: ([] as { id: string }[]).map((challenge) => ({
          id: challenge.id,
          status: "satisfied",
          reason: "The actual module test exercises the promised value",
          evidence: ["C001"],
        })),
        feedback: moduleFeedback(product.packet.current as unknown as ProductReviewBundle),
      },
      comparison: [],
    }),
  );
  expect(await runProductDone(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: { closed: true },
  });
  expect(await runProductAccept(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { passed: true },
  });
  expect(await run({ operation: "status", task: undefined })).toMatchObject({
    ok: true,
    value: { next: "normal-acceptance", callsUsed: 2 },
  });
});

it("aborts a brief revision without changing brief or authorization when critic history is malformed", async () => {
  value(await configure());
  const before = await record();
  const { criticSelection } = await import("../../../../src/workflow/product/critic-store.js");
  const selection = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(selection.path, "malformed");
  expect(
    await updateProductBrief(await setup.workspace.state(), {
      brief: { ...setup.brief, uncertainties: ["New method question"] },
      reason: "Investigate",
    }),
  ).toMatchObject({ ok: false });
  expect((await record()).briefText).toBe(before.briefText);
  expect((await record()).stateText).toBe(before.stateText);
});

it("invalidates visual slice review identity when design changes without turning a style choice into protected intent", async () => {
  const { sliceDigest } = await import("../../../../src/workflow/product/model.js");
  const { criticIntent } = await import("../../../../src/workflow/product/critic-store.js");
  const brief = {
    ...setup.brief,
    outcomes: [
      ...setup.brief.outcomes,
      {
        id: "O002",
        kind: "experience" as const,
        statement: "An appealing usable game",
        priority: "must" as const,
        provenance: "agent-proposed" as const,
        reviewRequired: true,
        expectations: [],
      },
    ],
    slices: setup.brief.slices.map((slice) => ({
      ...slice,
      outcomes: [...slice.outcomes, "O002"],
    })),
    design: { description: "Flat outlined art", references: [], refinementCycles: 2 },
  };
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief,
      reason: "Propose a visual approach",
    }),
  );
  value(await configure());
  const design = await prepare();
  value(await submit(design.attempt, answer(design.packet)));
  const revised = {
    ...brief,
    design: { ...brief.design, description: "Layered lighting and richer character detail" },
  };
  value(
    await updateProductBrief(await setup.workspace.state(), {
      brief: revised,
      reason: "Improve the observed aesthetic direction",
    }),
  );
  const slice = needed(brief.slices[0]);
  expect(sliceDigest(brief, slice)).not.toBe(sliceDigest(revised, slice));
  expect(criticIntent(brief, slice)).toBe(criticIntent(revised, slice));
  expect(sliceDigest(brief, needed(setup.brief.slices[0]))).toBe(
    sliceDigest(revised, needed(setup.brief.slices[0])),
  );
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 1, next: "review" },
  });
});

it("retains valid late understanding findings as advice without accepting the review or replenishing calls", async () => {
  value(await configure());
  const p = await prepare();
  const response = answer(p.packet);
  response.review.feedback.findings = [
    {
      dimension: "experience",
      problem: "Primary activity is too small",
      nextCheck: "Inspect the first mobile render",
      required: true,
      outcomes: [],
      evidence: [],
    },
  ];
  vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
  expect(await submit(p.attempt, response)).toMatchObject({
    ok: true,
    value: { callsUsed: 1, advisory: expect.any(String) },
  });
  expect((await record()).state.reviews).toHaveLength(0);
  expect(await criticUnderstanding(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: {
      status: "unavailable",
      requiredBeforeWork: false,
      advisory: expect.any(String),
      findings: [expect.objectContaining({ problem: "Primary activity is too small" })],
    },
  });
});

it.each(["model", "source", "selection"])(
  "does not retain late %s-invalid feedback as advice",
  async (kind) => {
    value(await configure());
    const p = await prepare();
    const response = answer(p.packet);
    if (kind === "source") await setup.workspace.write("src/value.mjs", "export const value = 99;");
    if (kind === "selection") response.review.subjectDigest = "other";
    vi.spyOn(Date, "now").mockReturnValue(p.expiresAt + 1);
    const result = value(
      await submit(p.attempt, response, kind === "model" ? { model: "wrong" } : {}),
    ) as { advisory?: string; callsUsed: number };
    expect(result.callsUsed).toBe(1);
    expect(result.advisory).toBeUndefined();
    expect((await record()).state.reviews).toHaveLength(0);
  },
);

it("records an unavailable early host without consuming a call, permits work and keeps final review required", async () => {
  value(await configure());
  const denied = value(
    await run({
      operation: "preflight",
      phase: "understanding",
      capabilities: { ...capabilities, delegationAllowed: false },
    }),
  ) as { ready: boolean };
  expect(denied.ready).toBe(false);
  expect(
    await run({ operation: "submit", phase: "product", failure: "Host unavailable" }),
  ).toMatchObject({ ok: false });
  expect(
    await run({
      operation: "submit",
      phase: "understanding",
      failureKind: "permission-denied",
      failure: "Host refused delegation",
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 0, action: "worker", status: "unavailable" } });
  expect(await criticUnderstanding(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
    value: undefined,
  });
  value(await runProductWork(await setup.workspace.state(), { task: "T001" }));
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductVerify(await setup.workspace.state(), { task: "T001" }));
  expect((await record()).state.reviews).toHaveLength(0);
  expect(await runProductNext(await setup.workspace.state())).toMatchObject({
    ok: true,
    value: { criticAdvice: { status: "suggested" } },
  });
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { enabled: true, callsUsed: 0 },
  });
});

it("cannot replace a pending consultation with an unreserved availability report", async () => {
  value(await configure());
  await prepare();
  expect(
    await run({ operation: "submit", phase: "understanding", failure: "Host refused" }),
  ).toMatchObject({ ok: false, error: { code: "STATE_BUSY" } });
  expect(await run({ operation: "status" })).toMatchObject({ ok: true, value: { callsUsed: 1 } });
});
