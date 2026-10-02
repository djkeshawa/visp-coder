import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { ok } from "../../../../src/core/result.js";
import { reviewCodeSources } from "../../../../src/workflow/product/code-context.js";
import type { CriticPacket } from "../../../../src/workflow/product/critic-packet.js";
import { independentSources } from "../../../../src/workflow/product/independent-sources.js";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { initialProductState, productBriefSchema } from "../../../../src/workflow/product/model.js";
import { deliveredEvidenceIdsSchema } from "../../../../src/workflow/product/review-delivery-validation.js";
import { runProductReviewRequest } from "../../../../src/workflow/product/review-request.js";
import {
  deliveredSources,
  reviewPacketBudgetGap,
} from "../../../../src/workflow/product/review-source-delivery.js";
import type { WorkspaceState } from "../../../../src/workflow/state.js";
import { productWorkspace } from "../../support/product-workspace.js";

function requireSuccess<T>(result: Result<T>): asserts result is { ok: true; value: T } {
  if (!result.ok) throw new Error(result.error.message);
}

function setup(contents: Record<string, string>, verifierFiles: string[] = []) {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-review",
    originalRequest: "Evaluate formulas",
    goal: "Evaluate formulas",
    outcomes: [{ id: "O001", kind: "functional", statement: "Evaluate formulas" }],
    checks: [
      {
        id: "C001",
        command: ["node", "tests/check.mjs"],
        files: [],
        verifierFiles,
        outcomes: ["O001"],
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Evaluate formulas",
        outcomes: ["O001"],
        checks: ["C001"],
        scope: { allowed: ["**"] },
      },
    ],
  });
  const record = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "2026-01-01"),
  };
  const workspace = {
    files: {
      readTextIfExists: async (path: string) => ok(contents[path]),
      readBytesIfExists: async (path: string) =>
        ok(contents[path] === undefined ? undefined : Buffer.from(contents[path])),
    },
  } as unknown as WorkspaceState;
  const snapshot = Object.fromEntries(
    Object.entries(contents).map(([path, text]) => [path, sha256(text)]),
  );
  return { brief, record, workspace, snapshot };
}
it("changed implementation with test-like filename remains core", async () => {
  const f = setup({
    "index.mjs": "export const decoy = 1;",
    "src/formulas.test.mjs": "export function evaluate() { return 999; }",
    "tests/check.mjs": "import {evaluate} from '../src/formulas.test.mjs'; evaluate();",
  });
  const sources = await reviewCodeSources(
    f.workspace,
    f.record,
    f.snapshot,
    "current",
    undefined,
    new Set(["src/formulas.test.mjs"]),
  );
  const result = await independentSources(f.workspace, sources);
  requireSuccess(result);
  expect(result.value.find((s) => s.reference === "src/formulas.test.mjs")?.coreOutcomes).toEqual([
    "O001",
  ]);
});
it("worker verifierFiles cannot remove changed implementation from core", async () => {
  const f = setup(
    {
      "index.mjs": `export const decoy = '${"x".repeat(31500)}';`,
      "src/engine.mjs": "export function evaluate() { return 999; }",
      "tests/check.mjs": "import {evaluate} from '../src/engine.mjs'; evaluate();",
    },
    ["src/engine.mjs"],
  );
  const sources = await reviewCodeSources(
    f.workspace,
    f.record,
    f.snapshot,
    "current",
    undefined,
    new Set(["src/engine.mjs"]),
  );
  const result = await independentSources(f.workspace, sources);
  requireSuccess(result);
  expect(result.value.find((s) => s.reference === "src/engine.mjs")?.coreOutcomes).toEqual([
    "O001",
  ]);
});
it("serialized review session retains failing output after compaction", async () => {
  const p = await productWorkspace();
  try {
    const script =
      "console.log(Array.from({length:600},(_,i)=>'PASS: formula works '+i).join('\\n')); console.log(['FAIL:', 'late_formula_is_wrong'].join(' ')); process.exitCode=1;\n";
    await p.workspace.write("test/check.mjs", script);
    const updated = await updateProductBrief(await p.workspace.state(), {
      brief: {
        ...p.brief,
        checks: [
          { ...p.brief.checks[0], command: [process.execPath, "test/check.mjs"], files: [] },
        ],
        slices: [
          {
            ...p.brief.slices[0],
            scope: { allowed: ["src/value.mjs", "test/check.mjs"], expected: [], forbidden: [] },
          },
        ],
      },
      reason: "Exercise output delivery",
    });
    requireSuccess(updated);
    const worked = await runProductWork(await p.workspace.state(), { task: "T001" });
    requireSuccess(worked);
    await p.workspace.write("src/value.mjs", `export const value = 2;\n//${"x".repeat(29000)}\n`);
    await runProductVerify(await p.workspace.state(), { task: "T001" });
    const state = await p.workspace.state();
    const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
    requireSuccess(prepared);
    const read = await state.files.readText((prepared.value as { packetPath: string }).packetPath);
    requireSuccess(read);
    const packet = JSON.parse(read.value);
    const results = JSON.stringify({
      sources: packet.sources.filter(
        (s: { kind: string; id: string }) => s.kind === "executed-check",
      ),
      evidence: packet.evidence,
    });
    expect(results).toContain("FAIL: late_formula_is_wrong");
  } finally {
    await p.workspace.destroy();
  }
});
it("delivered metadata stays bounded as core candidate count grows", async () => {
  const core = Array.from({ length: 2000 }, (_, i) => ({
    id: `CODE-${i}`,
    kind: "implementation-file" as const,
    reference: `src/module${i}.js`,
    sha256: sha256("x"),
    available: true,
    coreOutcomes: ["O001"],
    excerpt: "export const x=1;",
  }));
  const delivered = await deliveredSources(core, new Map());
  const ids = delivered.map((source) => source.id);
  expect(deliveredEvidenceIdsSchema.safeParse(ids).success).toBe(true);
  expect(JSON.stringify(ids).length).toBeLessThanOrEqual(32000);
  const gap = delivered.find((source) => source.id === "CODE-CORE-GAPS");
  const omitted = Number(/Limited candidates: (\d+)/.exec(gap?.excerpt ?? "")?.[1]);
  expect(omitted + delivered.filter((source) => source.coreOutcomes !== undefined).length).toBe(
    2000,
  );
});
it("reviewer can cite delivered core limitation ID in a prepared session", async () => {
  const p = await productWorkspace();
  try {
    const worked = await runProductWork(await p.workspace.state(), { task: "T001" });
    requireSuccess(worked);
    await p.workspace.write(
      "src/value.mjs",
      `export const value = 2;\n${"// context\n".repeat(4000)}`,
    );
    await runProductVerify(await p.workspace.state(), { task: "T001" });
    const state = await p.workspace.state();
    const prepared = await runProductReviewRequest(state, { prepare: true, task: "T001" });
    requireSuccess(prepared);
    const value = prepared.value as { session: string; packetPath: string };
    const read = await state.files.readText(value.packetPath);
    requireSuccess(read);
    expect(
      JSON.parse(read.value).sources.some(
        (s: { kind: string; id: string }) => s.id === "CODE-CORE-GAPS",
      ),
    ).toBe(true);
    const result = await runProductReviewRequest(state, {
      session: value.session,
      assessments: [
        {
          outcome: "O001",
          status: "unclear",
          summary: "Core source is truncated",
          evidence: ["CODE-CORE-GAPS"],
          expectations: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
  } finally {
    await p.workspace.destroy();
  }
});
it("final serialized source bound includes outcome limitation metadata", async () => {
  const source = {
    id: "CORE",
    kind: "implementation-file" as const,
    reference: "main.js",
    sha256: sha256("export const x=1"),
    available: true,
    coreOutcomes: Array.from({ length: 4000 }, (_, i) => `O${String(i).padStart(4, "0")}`),
    excerpt: "export const x=1",
  };
  await expect(deliveredSources([source], new Map())).rejects.toThrow(
    /Exact core outcome limitations.*no review call spent/,
  );
});
it.each(["native", "legacy-native", "attached"])(
  "%s critic refuses citation of a candidate trimmed from its packet",
  async (transport) => {
    const { balancedCritic } = await import("../../../../src/config/critic.js");
    const { runProductCritic } = await import("../../../../src/workflow/product/critic.js");
    const { criticSelection, readCriticState } = await import(
      "../../../../src/workflow/product/critic-store.js"
    );
    const p = await productWorkspace({ critic: true });
    try {
      const updated = await updateProductBrief(await p.workspace.state(), {
        brief: {
          ...p.brief,
          checks: [{ ...p.brief.checks[0], files: ["src/**", "test/**"] }],
          slices: [
            {
              ...p.brief.slices[0],
              scope: { allowed: ["src/**", "test/**"], expected: [], forbidden: [] },
            },
          ],
        },
        reason: "Exercise delivered citation validation",
      });
      requireSuccess(updated);
      for (let i = 0; i < 200; i++)
        await p.workspace.write(`src/module${i}.mjs`, "export const x=2;\n");
      const worked = await runProductWork(await p.workspace.state(), { task: "T001" });
      requireSuccess(worked);
      await p.workspace.write("src/value.mjs", "export const value = 2;\n");
      const verified = await runProductVerify(await p.workspace.state(), { task: "T001" });
      requireSuccess(verified);
      const base = balancedCritic("codex");
      if (!base) throw new Error("Missing critic defaults");
      const config = { ...base, maxCalls: 2 };
      const capabilities = {
        harness: "codex" as const,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      };
      const state = await p.workspace.state();
      const configured = await runProductCritic(state, {
        task: "T001",
        operation: "configure",
        config,
      });
      requireSuccess(configured);
      const { readProductRecord } = await import("../../../../src/workflow/product/store.js");
      const record = await readProductRecord(state);
      requireSuccess(record);
      const candidates = await reviewCodeSources(
        state,
        record.value,
        undefined,
        undefined,
        record.value.brief.slices[0],
      );
      const responseFor = (packet: CriticPacket) => {
        const omitted = candidates.find(
          (source) =>
            !packet.current.sources.some((entry) => entry.id === source.id) &&
            !packet.current.evidence.some((entry) => entry.id === source.id),
        );
        expect(omitted).toBeDefined();
        if (!omitted) throw new Error("No omitted candidate");
        return {
          summary: "Inspection remains incomplete",
          assessments: [
            {
              outcome: "O001",
              status: "unclear",
              summary: "Referenced candidate source",
              evidence: [omitted.id],
              expectations: [],
            },
          ],
          findings: [],
          limitations: [],
          resolutions: [],
          disputes: [],
        };
      };
      if (transport === "attached") {
        const reviewed = await runProductCritic(
          state,
          { task: "T001", operation: "review" },
          {
            inspect: async () => capabilities,
            review: async (packet) => ({
              model: config.model,
              reasoningEffort: config.reasoningEffort,
              context: "fresh",
              response: responseFor(packet),
            }),
          },
        );
        expect(reviewed.ok).toBe(true);
      } else {
        const prepared = await runProductCritic(state, {
          task: "T001",
          operation: "prepare",
          capabilities,
        });
        requireSuccess(prepared);
        const val = prepared.value as { attempt: string; packetPath: string };
        const packetRead = await state.files.readText(val.packetPath);
        requireSuccess(packetRead);
        const packet = JSON.parse(packetRead.value) as CriticPacket;
        const selected = await criticSelection(state, { task: "T001" });
        requireSuccess(selected);
        const before = await readCriticState(state, selected.value);
        requireSuccess(before);
        expect(before.value.state?.attempts.at(-1)?.deliveredSourceManifest).toBeUndefined();
        const oldState = structuredClone(before.value.state);
        if (!oldState) throw Error("Missing critic state");
        const oldAttempt = oldState.attempts.at(-1);
        if (!oldAttempt) throw Error("Missing critic attempt");
        delete oldAttempt.deliveredEvidenceIds;
        oldAttempt.deliveredSourceManifest = [
          {
            id: "CODE-old",
            reference: "old.js",
            sha256: "",
            candidateExcerptSha256: "",
            delivered: false,
            available: false,
            excerptChars: 0,
            truncated: true,
          },
        ];
        const { criticStateSchema } = await import(
          "../../../../src/workflow/product/critic-model.js"
        );
        expect(criticStateSchema.safeParse(oldState).success).toBe(true);
        if (transport === "legacy-native")
          await writeFile(selected.value.path, JSON.stringify(oldState));
        const submitted = await runProductCritic(state, {
          task: "T001",
          operation: "submit",
          attempt: val.attempt,
          response: responseFor(packet),
          capabilities,
        });
        expect(submitted.ok).toBe(true);
      }
      const afterSelected = await criticSelection(state, { task: "T001" });
      requireSuccess(afterSelected);
      const after = await readCriticState(state, afterSelected.value);
      requireSuccess(after);
      expect(after.value.state?.attempts.at(-1)?.status).toBe("unavailable");
      expect(after.value.state?.attempts.at(-1)?.message).toContain("Unknown evidence reference");
      expect(
        JSON.stringify(after.value.state?.attempts.at(-1)?.deliveredEvidenceIds ?? []).length,
      ).toBeLessThanOrEqual(32000);
    } finally {
      await p.workspace.destroy();
    }
  },
);

it("retains unchanged scoped implementation even when the check executes that file directly", async () => {
  const f = setup(
    {
      "index.mjs": `export const decoy = '${"x".repeat(31500)}';`,
      "src/engine.mjs": "export function evaluate() { return 999; }",
    },
    ["src/engine.mjs"],
  );
  const check = f.brief.checks[0];
  if (!check) throw new Error("Missing check");
  check.command = ["node", "src/engine.mjs"];
  const sources = await reviewCodeSources(f.workspace, f.record, f.snapshot, "current");
  const result = await independentSources(f.workspace, sources);
  requireSuccess(result);
  expect(
    result.value.find((source) => source.reference === "src/engine.mjs")?.coreOutcomes,
  ).toEqual(["O001"]);
});

it("retains execution summaries when their truncated target does not contain the full output", async () => {
  const { deliveredSourceEvidence } = await import(
    "../../../../src/workflow/product/review-source-delivery.js"
  );
  const source = {
    id: "CHECK-one",
    kind: "executed-check" as const,
    reference: "check",
    sha256: "",
    available: true,
    excerpt: "Check failed\nPASS: first case",
    truncated: true,
  };
  const receipt = {
    id: source.id,
    kind: "execution" as const,
    status: "failed" as const,
    outcomes: ["O001"],
    summary:
      "Check failed\nPASS: first case\nFAIL: late case\nNOT OBSERVED: retry\nLimitation: no cleanup observed",
  };
  expect(deliveredSourceEvidence([receipt], [source], [source])[0]?.summary).toBe(receipt.summary);
});

it("preserves unavailable core limitation notes while fitting available source", async () => {
  const missing = {
    id: "CODE-missing",
    kind: "implementation-file" as const,
    reference: "missing.js",
    sha256: "",
    available: false,
    coreOutcomes: ["O001"],
    excerpt: "Limitation: implementation bytes could not be read",
  };
  const large = {
    ...missing,
    id: "CODE-large",
    reference: "large.js",
    available: true,
    excerpt: "// context\n".repeat(4000),
  };
  const delivered = await deliveredSources([large, missing], new Map());
  expect(delivered.find((source) => source.id === missing.id)?.excerpt).toBe(missing.excerpt);
  expect(delivered.filter((source) => source.id === missing.id)).toHaveLength(1);
  expect(JSON.stringify(delivered).length).toBeLessThanOrEqual(32000);
});

it("enforces both record and serialized bounds on new delivered-ID metadata", () => {
  expect(
    deliveredEvidenceIdsSchema.safeParse(Array.from({ length: 1001 }, (_, index) => `ID-${index}`))
      .success,
  ).toBe(false);
  expect(
    deliveredEvidenceIdsSchema.safeParse(Array.from({ length: 200 }, () => "x".repeat(200)))
      .success,
  ).toBe(false);
  expect(deliveredEvidenceIdsSchema.safeParse(["x".repeat(201)]).success).toBe(false);
});

it("rejects an oversized final packet before reserving or invoking an attached review", async () => {
  const { balancedCritic } = await import("../../../../src/config/critic.js");
  const { runProductCritic } = await import("../../../../src/workflow/product/critic.js");
  const { criticSelection, readCriticState } = await import(
    "../../../../src/workflow/product/critic-store.js"
  );
  const p = await productWorkspace({ critic: true });
  try {
    const worked = await runProductWork(await p.workspace.state(), { task: "T001" });
    requireSuccess(worked);
    await p.workspace.write("src/value.mjs", "export const value = 2;\n");
    const verified = await runProductVerify(await p.workspace.state(), { task: "T001" });
    requireSuccess(verified);
    const state = await p.workspace.state();
    const base = balancedCritic("codex");
    if (!base) throw new Error("Missing critic defaults");
    const config = { ...base, maxCalls: 2 };
    const configured = await runProductCritic(state, {
      task: "T001",
      operation: "configure",
      config,
    });
    requireSuccess(configured);
    let invoked = false;
    const result = await runProductCritic(
      state,
      { task: "T001", operation: "review", question: "x".repeat(256000) },
      {
        inspect: async () => ({
          harness: "codex" as const,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          freshContext: true,
          images: true,
          readOnly: true,
          delegationAllowed: true,
        }),
        review: async () => {
          invoked = true;
          throw Error("Oversized review was dispatched");
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("no review call spent") },
    });
    expect(invoked).toBe(false);
    const selected = await criticSelection(state, { task: "T001" });
    requireSuccess(selected);
    const stored = await readCriticState(state, selected.value);
    requireSuccess(stored);
    expect(stored.value.state?.attempts).toEqual([]);
  } finally {
    await p.workspace.destroy();
  }
});

it("compacts identical full core bytes before cutting source, with the target actually delivered", async () => {
  const text = `export const value = 2;\n${"// context\n".repeat(1900)}`;
  const sources = ["A", "B"].map((id) => ({
    id: `CODE-${id}`,
    kind: "implementation-file" as const,
    reference: `${id}.js`,
    sha256: sha256(text),
    available: true,
    coreOutcomes: ["O001"],
    excerpt: text,
  }));
  const delivered = await deliveredSources(sources, new Map());
  expect(delivered.find((source) => source.id === "CODE-A")?.excerpt).toBe(text);
  expect(delivered.find((source) => source.id === "CODE-B")?.excerpt).toContain("CODE-A");
  expect(delivered.some((source) => source.id === "CODE-CORE-GAPS")).toBe(false);
  expect(JSON.stringify(delivered).length).toBeLessThanOrEqual(32000);
});

it("retains observed changed and imported files without a recognized source extension", async () => {
  const f = setup({
    "src/engine": "export function evaluate() { return 999; }",
    "schema.json": '{"formula": "wrong"}',
    "tests/check.mjs": "import data from '../schema.json'; console.log(data);",
  });
  const slice = f.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  slice.scope.allowed = ["src/engine"];
  const sources = await reviewCodeSources(
    f.workspace,
    f.record,
    f.snapshot,
    "current",
    undefined,
    new Set(["src/engine"]),
  );
  const result = await independentSources(f.workspace, sources);
  requireSuccess(result);
  expect(result.value.find((source) => source.reference === "src/engine")?.coreOutcomes).toEqual([
    "O001",
  ]);
  expect(result.value.find((source) => source.reference === "schema.json")?.coreOutcomes).toEqual([
    "O001",
  ]);
});

it("preserves unavailable verifier notes when exact output consumes the candidate excerpt allowance", async () => {
  const { executionSchema } = await import("../../../../src/workflow/product/model.js");
  const { productContractDigest } = await import("../../../../src/workflow/product/subject.js");
  const f = setup({
    "src/engine.mjs": `export const value = '${"x".repeat(29000)}';`,
    "tests/check.mjs": "// verifier with a NUL byte\0\n",
  });
  const slice = f.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  slice.scope.allowed = ["src/engine.mjs"];
  f.record.state.executions = [
    executionSchema.parse({
      id: "EXE-current",
      check: "C001",
      task: slice.id,
      subjectDigest: "current",
      contractDigest: productContractDigest(f.brief, slice),
      createdAt: "2026-01-01",
      command: "node tests/check.mjs",
      provenance: "supervisor-executed",
      assertions: "agent-reported",
      status: "passed",
      exitCode: 0,
      durationMs: 1,
      output: "PASS: case\n".repeat(2300),
    }),
  ];
  const candidates = await reviewCodeSources(f.workspace, f.record, f.snapshot, "current", slice);
  const delivered = await independentSources(f.workspace, candidates);
  requireSuccess(delivered);
  expect(
    delivered.value.find((source) => source.reference === "tests/check.mjs")?.excerpt,
  ).toContain("Source is missing or binary");
  expect(JSON.stringify(delivered.value).length).toBeLessThanOrEqual(32000);
});

it("checks the source budget for understanding consultations too", async () => {
  const text = "x".repeat(33000);
  const f = setup({ "src/engine.mjs": text });
  const result = await independentSources(
    f.workspace,
    [
      {
        id: "CODE-engine",
        kind: "implementation-file",
        reference: "src/engine.mjs",
        sha256: sha256(text),
        available: true,
        excerpt: text,
      },
    ],
    true,
  );
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("source budget; no review call spent") },
  });
});

it("bounds actual formatted packet text and only excludes image data", () => {
  expect(reviewPacketBudgetGap({ data: "x".repeat(256000) })).toContain("text budget");
  const packet = { outcomes: Array.from({ length: 10000 }, () => ({ id: "O001" })) };
  expect(JSON.stringify(packet).length).toBeLessThan(248000);
  expect(JSON.stringify(packet, null, 2).length).toBeGreaterThan(256000);
  expect(reviewPacketBudgetGap(packet)).toContain("text budget");
  expect(
    reviewPacketBudgetGap({ image: { mimeType: "image/png", data: "x".repeat(256000) } }),
  ).toBeUndefined();
});

it("applies final source limits to the manual reviewer handoff", async () => {
  const { runProductReviewerHandoff } = await import(
    "../../../../src/workflow/product/reviewer-handoff.js"
  );
  const p = await productWorkspace();
  try {
    const updated = await updateProductBrief(await p.workspace.state(), {
      brief: {
        ...p.brief,
        slices: [{ ...p.brief.slices[0], scope: { allowed: ["src/**"] } }],
      },
      reason: "Exercise manual handoff delivery",
    });
    requireSuccess(updated);
    for (let index = 0; index < 250; index++)
      await p.workspace.write(`src/module${index}.mjs`, "export const value = 2;\n");
    const state = await p.workspace.state();
    const handoff = await runProductReviewerHandoff(state, { task: "T001" });
    requireSuccess(handoff);
    expect(JSON.stringify(handoff.value.sources).length).toBeLessThanOrEqual(32000);
    expect(reviewPacketBudgetGap(handoff.value)).toBeUndefined();
    expect(handoff.value.sources.some((source) => source.id === "CODE-CORE-GAPS")).toBe(true);
    const submitted = await runProductReviewRequest(state, {
      task: "T001",
      subjectDigest: handoff.value.subjectDigest,
      selection: handoff.value.submission.selection,
      assessments: [
        {
          outcome: "O001",
          status: "unclear",
          summary: "The delivered source has explicit limitations",
          evidence: ["CODE-CORE-GAPS"],
          expectations: [],
        },
      ],
      reviewer: { context: "current" },
    });
    requireSuccess(submitted);
  } finally {
    await p.workspace.destroy();
  }
});
