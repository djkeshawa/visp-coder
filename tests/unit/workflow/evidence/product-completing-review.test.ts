import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  type CriticPacket,
  type ProductCriticHost,
  runProductCritic,
} from "../../../../src/workflow/product/critic.js";
import {
  featureCriticCapacity,
  readFeatureCriticBudget,
} from "../../../../src/workflow/product/critic-budget.js";
import {
  criticSelection,
  readCriticState,
  saveCriticState,
} from "../../../../src/workflow/product/critic-store.js";
import {
  inlineReview,
  runProductDoneReviewed,
} from "../../../../src/workflow/product/done-review.js";
import { runProductAccept } from "../../../../src/workflow/product/evidence.js";
import type { IndependentReview } from "../../../../src/workflow/product/independent-review.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

const config = {
  model: "test-critic",
  reasoningEffort: "high" as const,
  harness: "codex" as const,
  transport: "native" as const,
  maxCalls: 3,
  timeoutMs: 5000,
  maxImageBytes: 4194304,
};
let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  await setup?.workspace.destroy();
});

async function feature(
  maxCalls = 3,
  required = true,
  options: {
    distinct?: boolean;
    earlierFailure?: boolean;
    launch?: "host" | "codex-exec";
    timeoutMs?: number;
    slices?: number;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  setup = await productWorkspace({ critic: true });
  if (options.earlierFailure)
    await setup.workspace.write(
      "test/earlier.test.mjs",
      'import { readFileSync } from "node:fs";\nimport assert from "node:assert/strict";\nassert(!readFileSync("src/value.mjs", "utf8").includes("revision 2"));\n',
    );
  const raw = parse(await readFile(join(setup.workspace.root, "visp.yml"), "utf8"));
  raw.critic = {
    ...raw.critic,
    ...config,
    maxCalls,
    timeoutMs,
    mode: "auto",
    launch: options.launch ?? "codex-exec",
  };
  await setup.workspace.write("visp.yml", stringify(raw));
  setup.workspace.commit("configure launched reviewer");
  const updated = await updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      outcomes: [setup.brief.outcomes[0], { ...setup.brief.outcomes[0], id: "O002" }].map(
        (outcome) => ({ ...outcome, reviewRequired: required }),
      ),
      checks: (options.distinct
        ? ["O001", "O002"].map((outcome, index) => ({
            ...setup.brief.checks[0],
            id: `C00${index + 1}`,
            outcomes: [outcome],
          }))
        : setup.brief.checks
      ).map((check) => ({
        ...check,
        outcomes: options.distinct ? check.outcomes : ["O001", "O002"],
        command:
          options.earlierFailure && check.id === "C002"
            ? [process.execPath, "--test", "test/earlier.test.mjs"]
            : check.command,
        verifierFiles: [
          options.earlierFailure && check.id === "C002"
            ? "test/earlier.test.mjs"
            : "test/value.test.mjs",
        ],
      })),
      slices: ["T001", "T002", "T003", "T004", "T005"].slice(0, options.slices ?? 3).map((id) => ({
        ...setup.brief.slices[0],
        id,
        outcomes: [id === "T002" ? "O002" : "O001"],
        checks: [options.distinct && id === "T002" ? "C002" : "C001"],
      })),
    },
    reason: "Three independently completed slices",
    intentChange: {
      reason: "Require independent review of each outcome",
      provenance: "test fixture",
    },
  });
  expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "set-policy",
      enabled: true,
      harness: "codex",
    }),
  ).toMatchObject({ ok: true });
  expect(await runProductWork(await setup.workspace.state(), { task: "T001" })).toMatchObject({
    ok: true,
  });
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "configure",
      task: "T001",
      config: { ...config, maxCalls, timeoutMs },
    }),
  ).toMatchObject({ ok: true });
}

function answer(packet: CriticPacket): IndependentReview {
  return {
    summary: "Checked the current value assertion",
    assessments: packet.current.outcomes.map((outcome) => ({
      outcome: outcome.id,
      status: "satisfied",
      summary: "The executed assertion confirms the promised value",
      evidence: packet.current.evidence
        .filter(
          (entry) =>
            entry.kind === "execution" &&
            entry.status === "available" &&
            entry.outcomes.includes(outcome.id),
        )
        .map((entry) => entry.id),
      expectations: [],
    })),
    findings: [],
    limitations: [],
    resolutions: [],
    disputes: [],
  };
}

function host(): ProductCriticHost {
  return {
    inspect: async () => ({
      harness: "codex",
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    }),
    review: vi.fn(async (packet) => ({
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      context: "fresh" as const,
      response: answer(packet),
    })),
  };
}

async function done(task: string, reviewer: ProductCriticHost, revision: number) {
  await setup.workspace.write("src/value.mjs", `export const value = 2; // revision ${revision}\n`);
  return runProductDoneReviewed(await setup.workspace.state(), { task }, inlineReview(reviewer));
}

async function capacity() {
  const budget = await readFeatureCriticBudget(
    await setup.workspace.state(),
    setup.brief.feature,
    config,
  );
  if (!budget.ok) throw new Error(budget.error.message);
  return featureCriticCapacity(budget.value.budget);
}

it.each([false, true])(
  "uses distinct checks=%s and the third native review to assess every outcome at the completing subject and accept without another call",
  async (distinct) => {
    await feature(3, true, { distinct });
    const reviewer = host();
    for (const [index, task] of ["T001", "T002", "T003"].entries()) {
      if (index)
        expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
          ok: true,
        });
      const result = await done(task, reviewer, index);
      expect(result, `${task}: ${JSON.stringify(result)}`).toMatchObject({
        ok: true,
        value: { closed: true, critic: { reviewed: true } },
      });
      if (index === 2)
        expect(result).toMatchObject({
          ok: true,
          value: {
            next: { action: "accept", command: `visp accept --feature ${setup.brief.feature}` },
          },
        });
    }
    expect(reviewer.review).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reviewer.review).mock.calls[2]?.[0]).toMatchObject({
      selection: { task: undefined },
      current: { outcomes: [{ id: "O001" }, { id: "O002" }] },
    });
    for (const [index, task] of ["T001", "T002", undefined].entries()) {
      const packet = vi.mocked(reviewer.review).mock.calls[index]?.[0];
      const source = packet?.current.sources.find((entry) => entry.reference === "src/value.mjs");
      expect(source?.excerpt).toContain(`revision ${index}`);
      const workspace = await setup.workspace.state();
      const selected = await criticSelection(
        workspace,
        { feature: setup.brief.feature, task },
        index === 2,
      );
      if (!selected.ok) throw new Error(selected.error.message);
      const stored = await readCriticState(workspace, selected.value);
      if (!stored.ok) throw new Error(stored.error.message);
      expect(stored.value.state?.attempts.at(-1)?.deliveredEvidenceIds).toContain(source?.id);
      expect(stored.value.state?.attempts.at(-1)?.deliveredSourceManifest).toBeUndefined();
    }
    const record = await readProductRecord(await setup.workspace.state());
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.state.reviews.at(-1)).toMatchObject({
      assessments: [{ outcome: "O001" }, { outcome: "O002" }],
    });
    if (distinct) {
      const subject = record.value.state.reviews.at(-1)?.subjectDigest;
      expect(subject).toBeDefined();
      expect(
        record.value.state.executions.find(
          (entry) => entry.check === "C002" && entry.subjectDigest === subject,
        )?.task,
      ).toBeUndefined();
      expect(record.value.state.executions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "C001",
            task: "T003",
            subjectDigest: subject,
            status: "passed",
          }),
          expect.objectContaining({
            check: "C002",
            subjectDigest: subject,
            contractDigest: productContractDigest(record.value.brief),
            status: "passed",
          }),
        ]),
      );
    }
    expect(await capacity()).toMatchObject({ callsUsed: 3, callsRemaining: 0 });
    expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
      ok: true,
      value: { passed: true, gaps: [] },
    });
  },
);

it("skips a non-completing review with no clean predecessor to reserve the last call, without counting it", async () => {
  await feature(1, false);
  const reviewer = host();
  for (const [index, task] of ["T001", "T002"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    expect(await done(task, reviewer, index)).toMatchObject({
      ok: true,
      value: {
        closed: true,
        critic: { reviewed: false, reason: expect.stringContaining("reserve") },
      },
    });
    expect(await capacity()).toMatchObject({ callsUsed: 0, callsRemaining: 1 });
  }
  expect(reviewer.review).not.toHaveBeenCalled();
  expect(await runProductWork(await setup.workspace.state(), { task: "T003" })).toMatchObject({
    ok: true,
  });
  expect(await done("T003", reviewer, 3)).toMatchObject({
    ok: true,
    value: { critic: { reviewed: true } },
  });
  expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
    ok: true,
    value: { passed: true },
  });
});

it("spends the reserved call when a middle slice cannot close without its must review", async () => {
  await feature(1);
  const reviewer = host();
  expect(await done("T001", reviewer, 1)).toMatchObject({
    ok: true,
    value: { closed: true, critic: { reviewed: true } },
  });
  expect(await capacity()).toMatchObject({ callsUsed: 1, callsRemaining: 0 });
  expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED" },
  });
});

it("reserves the last dispatch when nominal calls remain but the time budget is tight", async () => {
  await feature(6, false, { timeoutMs: 300_000, slices: 4 });
  const malformed = host();
  malformed.review = vi.fn(async () => ({
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    context: "fresh" as const,
    response: {},
  }));
  for (const [index, task] of ["T001", "T002", "T003"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    const result = await done(task, malformed, index);
    expect(result).toMatchObject({ ok: true, value: { closed: true } });
    if (index === 2)
      expect(result).toMatchObject({
        ok: true,
        value: { critic: { reviewed: false, reason: expect.stringContaining("reserve") } },
      });
  }
  expect(malformed.review).toHaveBeenCalledTimes(2);
  expect(await capacity()).toMatchObject({ callsRemaining: 4, reservedMs: 600_000 });
  expect(await runProductWork(await setup.workspace.state(), { task: "T004" })).toMatchObject({
    ok: true,
  });
  expect(await done("T004", host(), 4)).toMatchObject({
    ok: true,
    value: { critic: { reviewed: true } },
  });
  expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
    ok: true,
    value: { passed: true },
  });
});

it("keeps host implicit and explicit review scoped to the open completing slice until closure", async () => {
  await feature(3, false, { launch: "host", distinct: true });
  for (const [index, task] of ["T001", "T002"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    await setup.workspace.write("src/value.mjs", `export const value = 2; // revision ${index}\n`);
    expect(await runProductDoneReviewed(await setup.workspace.state(), { task })).toMatchObject({
      ok: true,
      value: { closed: true },
    });
  }
  expect(await runProductWork(await setup.workspace.state(), { task: "T003" })).toMatchObject({
    ok: true,
  });
  for (const options of [{}, { task: "T003" }]) {
    expect(await runProductReview(await setup.workspace.state(), options)).toMatchObject({
      ok: true,
      value: { task: "T003", outcomes: [{ id: "O001" }] },
    });
    const selected = await criticSelection(await setup.workspace.state(), options);
    expect(selected).toMatchObject({ ok: true, value: { selection: { task: "T003" } } });
  }
  const done = await runProductDoneReviewed(await setup.workspace.state(), { task: "T003" });
  expect(done).toMatchObject({ ok: true, value: { closed: true } });
  expect(done.ok && done.value.executions.map((entry) => entry.check)).not.toContain("C002");
  expect(await runProductReview(await setup.workspace.state(), {})).toMatchObject({
    ok: true,
    value: { outcomes: [{ id: "O001" }, { id: "O002" }] },
  });
});

it("reserves the completing selection's timeout even when the optional slice timeout is shorter", async () => {
  await feature(6, false, { timeoutMs: 300_000, slices: 5 });
  const workspace = await setup.workspace.state();
  const completing = await criticSelection(workspace, { feature: setup.brief.feature }, true);
  if (!completing.ok) throw new Error(completing.error.message);
  const stored = await readCriticState(workspace, completing.value);
  if (!stored.ok || !stored.value.state)
    throw new Error("Missing completing reviewer configuration");
  expect(
    await saveCriticState(workspace, completing.value, stored.value.text, {
      ...stored.value.state,
      config: { ...stored.value.state.config, timeoutMs: 180_000 },
    }),
  ).toMatchObject({ ok: true });
  const malformed = host();
  malformed.review = vi.fn(async () => ({
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    context: "fresh" as const,
    response: {},
  }));
  for (const [index, task] of ["T001", "T002", "T003"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    const result = await done(task, malformed, index);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { closed: true } });
  }
  expect(await runProductWork(await setup.workspace.state(), { task: "T004" })).toMatchObject({
    ok: true,
  });
  expect(
    await runProductCritic(await setup.workspace.state(), {
      operation: "configure",
      task: "T004",
      config: { ...config, maxCalls: 6 },
    }),
  ).toMatchObject({ ok: true });
  expect(await done("T004", malformed, 4)).toMatchObject({
    ok: true,
    value: { critic: { reviewed: false, reason: expect.stringContaining("reserve") } },
  });
  expect(await capacity()).toMatchObject({ callsRemaining: 3, remainingMs: 180_000 });
  expect(malformed.review).toHaveBeenCalledTimes(3);
  expect(await runProductWork(await setup.workspace.state(), { task: "T005" })).toMatchObject({
    ok: true,
  });
  expect(await done("T005", host(), 5)).toMatchObject({
    ok: true,
    value: { critic: { reviewed: true } },
  });
  expect(await capacity()).toMatchObject({ callsRemaining: 2, remainingMs: 0 });
});

it("blocks the completing dispatch when an earlier outcome's check fails on current source", async () => {
  await feature(3, true, { distinct: true, earlierFailure: true });
  const reviewer = host();
  for (const [index, task] of ["T001", "T002"].entries()) {
    if (index)
      expect(await runProductWork(await setup.workspace.state(), { task })).toMatchObject({
        ok: true,
      });
    expect(await done(task, reviewer, index)).toMatchObject({ ok: true, value: { closed: true } });
  }
  expect(await runProductWork(await setup.workspace.state(), { task: "T003" })).toMatchObject({
    ok: true,
  });
  expect(await done("T003", reviewer, 2)).toMatchObject({
    ok: true,
    value: {
      closed: false,
      executions: expect.arrayContaining([
        expect.objectContaining({ check: "C002", status: "failed" }),
      ]),
    },
  });
  expect(reviewer.review).toHaveBeenCalledTimes(2);
  expect(await capacity()).toMatchObject({ callsRemaining: 1 });
  expect(await runProductAccept(await setup.workspace.state(), {})).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED" },
  });
});
