import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../../src/config/critic.js";
import * as transactions from "../../../../src/core/file-transaction.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { featureCriticCapacity } from "../../../../src/workflow/product/critic-budget.js";
import { criticSelection } from "../../../../src/workflow/product/critic-store.js";
import { productStateSchema } from "../../../../src/workflow/product/model.js";
import { productStatePath } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
const preset = balancedCritic("codex");
if (!preset) throw new Error("missing preset");
const config = { ...preset, maxCalls: 1 };
const capabilities = {
  harness: "codex",
  model: config.model,
  reasoningEffort: "high",
  freshContext: true,
  images: true,
  readOnly: true,
  delegationAllowed: true,
} as const;
async function setup(limits = config) {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  const state = await p.workspace.state();
  const updated = await updateProductBrief(state, {
    brief: {
      ...p.brief,
      slices: [
        ...p.brief.slices,
        { ...p.brief.slices[0], id: "T002" },
        { ...p.brief.slices[0], id: "T003" },
      ],
    },
    reason: "Two slices share a feature budget",
  });
  expect(updated.ok).toBe(true);
  for (const task of ["T001", "T002"])
    expect(
      (await runProductCritic(state, { operation: "configure", task, config: limits })).ok,
    ).toBe(true);
  return p;
}
it("does not restore critic capacity by selecting another slice after restart", async () => {
  const p = await setup();
  expect(
    (
      await runProductCritic(await p.workspace.state(), {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        capabilities,
      })
    ).ok,
  ).toBe(true);
  const status = await runProductCritic(await p.workspace.state(), {
    operation: "status",
    task: "T002",
  });
  expect(status).toMatchObject({ ok: true, value: { callsUsed: 1, callsRemaining: 0 } });
  const next = await runProductCritic(await p.workspace.state(), {
    operation: "prepare",
    task: "T002",
    sourceOnly: true,
    capabilities,
  });
  expect(next).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", message: expect.stringContaining("budget") },
  });
});
it("does not let concurrent slices reserve more than the feature limit", async () => {
  const p = await setup();
  const results = await Promise.all(
    ["T001", "T002"].map(async (task) =>
      runProductCritic(await p.workspace.state(), {
        operation: "prepare",
        task,
        sourceOnly: true,
        capabilities,
      }),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  for (const task of ["T001", "T002"])
    expect(
      await runProductCritic(await p.workspace.state(), { operation: "status", task }),
    ).toMatchObject({ ok: true, value: { callsUsed: 1, callsRemaining: 0 } });
});

it("recovers historical spending without rewriting old attempts, and retains it if a source file disappears", async () => {
  const p = await setup();
  const state = await p.workspace.state();
  expect(
    (
      await runProductCritic(state, {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        capabilities,
      })
    ).ok,
  ).toBe(true);
  const selection = await criticSelection(state, { task: "T001" });
  if (!selection.ok) throw new Error(selection.error.message);
  const history = await readFile(selection.value.path, "utf8");
  const ledger = join(state.paths.featureDir(p.brief.feature), "critic-budget.json");
  const recorded = await readFile(ledger, "utf8");
  // Model a pre-ledger feature, not deletion of accounting from an upgraded feature.
  const statePath = productStatePath(state, p.brief.feature);
  const legacy = JSON.parse(await readFile(statePath, "utf8"));
  delete legacy.criticBudgetVersion;
  await writeFile(statePath, JSON.stringify(legacy));
  await rm(ledger);
  expect(
    await runProductCritic(await p.workspace.state(), { operation: "status", task: "T002" }),
  ).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 0, featureBudget: { reservedMs: config.timeoutMs } },
  });
  expect(await readFile(selection.value.path, "utf8")).toBe(history);
  await writeFile(ledger, recorded);
  await rm(selection.value.path);
  expect(
    await runProductCritic(await p.workspace.state(), {
      operation: "preflight",
      task: "T002",
      sourceOnly: true,
      capabilities,
    }),
  ).toMatchObject({ ok: true, value: { ready: false, callsUsed: 1, callsRemaining: 0 } });
});
it("refuses malformed feature accounting instead of resetting it", async () => {
  const p = await setup();
  const state = await p.workspace.state();
  await writeFile(join(state.paths.featureDir(p.brief.feature), "critic-budget.json"), "{}");
  expect(
    await runProductCritic(state, {
      operation: "prepare",
      task: "T001",
      sourceOnly: true,
      capabilities,
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
});

it("defaults new feature policies to three calls with a three-minute call deadline", () => {
  expect(balancedCritic("codex")).toMatchObject({ maxCalls: 3, timeoutMs: 180_000 });
});
it.each([1, 3])(
  "cannot change the pinned feature limit through a new slice configuration (%s)",
  async (maxCalls) => {
    const p = await setup({ ...config, maxCalls: 2 });
    expect(
      await runProductCritic(await p.workspace.state(), {
        operation: "configure",
        task: "T003",
        config: { ...config, maxCalls },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED", message: expect.stringContaining("feature") },
    });
    for (const task of ["T001", "T002"])
      expect(
        await runProductCritic(await p.workspace.state(), { operation: "status", task }),
      ).toMatchObject({ ok: true, value: { callsRemaining: 2, featureBudget: { limit: 2 } } });
  },
);
it("reports reservable calls constrained by time as well as call count", () => {
  expect(
    featureCriticCapacity(
      {
        version: 1,
        root: "root",
        feature: "feature",
        maxCalls: 6,
        maxReservedMs: 1_080_000,
        entries: [
          { key: "one", phase: "understanding", reservedMs: 300_000 },
          { key: "two", phase: "product", reservedMs: 300_000 },
        ],
      },
      300_000,
    ),
  ).toMatchObject({ callsRemaining: 4, remainingMs: 480_000, reservableCalls: 1 });
});

it.each([
  { timeoutMs: 180_000, attempts: 6, callsRemaining: 0 },
  { timeoutMs: 300_000, attempts: 3, callsRemaining: 3 },
])(
  "bounds repeated uncertain calls by count and aggregate time ($timeoutMs ms)",
  async (limits) => {
    const p = await setup({ ...config, maxCalls: 6, timeoutMs: limits.timeoutMs });
    let retryAfter: string | undefined;
    for (let index = 0; index < limits.attempts; index++) {
      const prepared = await runProductCritic(await p.workspace.state(), {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        capabilities: { ...capabilities, delegationAllowed: true },
        ...(retryAfter ? { retryAfter, reason: "Controlled fixture permits another attempt" } : {}),
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      retryAfter = (prepared.value as { attempt: string }).attempt;
      expect(
        (
          await runProductCritic(await p.workspace.state(), {
            operation: "submit",
            task: "T001",
            attempt: retryAfter,
            failure: "Controlled uncertain transport failure",
          })
        ).ok,
      ).toBe(true);
    }
    expect(
      await runProductCritic(await p.workspace.state(), { operation: "status", task: "T001" }),
    ).toMatchObject({
      ok: true,
      value: {
        callsUsed: limits.attempts,
        callsRemaining: limits.callsRemaining,
        reviewCapacity: { canReviewAndRecheck: false },
        recovery: { availableWithinBudget: false },
        featureBudget: { reservableCalls: 0, reservedMs: limits.attempts * limits.timeoutMs },
      },
    });
    expect(
      await runProductCritic(await p.workspace.state(), {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        retryAfter,
        reason: "No capacity remains",
        capabilities: { ...capabilities, delegationAllowed: true },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "STAGE_BLOCKED", message: expect.stringContaining("budget exhausted") },
    });
  },
);

it("marks the feature so older strict readers cannot ignore shared accounting", async () => {
  const p = await setup();
  const state = await p.workspace.state();
  const record = JSON.parse(await readFile(productStatePath(state, p.brief.feature), "utf8"));
  expect(record.criticBudgetVersion).toBe(1);
  expect(productStateSchema.omit({ criticBudgetVersion: true }).safeParse(record).success).toBe(
    false,
  );
});
it("refuses a missing ledger for an already upgraded feature instead of replenishing capacity", async () => {
  const p = await setup();
  const state = await p.workspace.state();
  await rm(join(state.paths.featureDir(p.brief.feature), "critic-budget.json"));
  expect(await runProductCritic(state, { operation: "status", task: "T001" })).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_MISSING" },
  });
});

it("recovers an interrupted reservation without separating its spending from its attempt", async () => {
  const p = await setup();
  const state = await p.workspace.state();
  const ledger = join(state.paths.featureDir(p.brief.feature), "critic-budget.json");
  const before = await readFile(ledger, "utf8");
  const apply = transactions.applyFileTransaction;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce((root, label, changes) =>
    apply(root, label, changes, {
      leavePreparedOnError: true,
      afterMutation: () => {
        throw new Error("Interrupted after writing the budget");
      },
    }),
  );
  expect(
    (
      await runProductCritic(state, {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        capabilities,
      })
    ).ok,
  ).toBe(false);
  // Reads do not recover or rewrite journals. Exercise the explicit recovery boundary.
  expect(await transactions.inspectFileTransactions(p.workspace.root)).toMatchObject({
    ok: true,
    value: { pending: [expect.any(String)] },
  });
  expect((await transactions.recoverFileTransactions(p.workspace.root)).ok).toBe(true);
  expect(
    await runProductCritic(await p.workspace.state(), { operation: "status", task: "T002" }),
  ).toMatchObject({ ok: true, value: { callsUsed: 0, callsRemaining: 1 } });
  expect(await readFile(ledger, "utf8")).toBe(before);
  expect(
    (
      await runProductCritic(await p.workspace.state(), {
        operation: "prepare",
        task: "T002",
        sourceOnly: true,
        capabilities,
      })
    ).ok,
  ).toBe(true);
  expect(
    await runProductCritic(await p.workspace.state(), { operation: "status", task: "T001" }),
  ).toMatchObject({ ok: true, value: { callsUsed: 1, callsRemaining: 0 } });
});

it.each([true, false])(
  "reports spending on an unconfigured slice when critic enabled is %s",
  async (enabled) => {
    const p = await setup();
    expect(
      (
        await runProductCritic(await p.workspace.state(), {
          operation: "prepare",
          task: "T001",
          sourceOnly: true,
          capabilities,
        })
      ).ok,
    ).toBe(true);
    const statePath = productStatePath(await p.workspace.state(), p.brief.feature);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.criticDefault;
    state.criticEnabled = enabled;
    await writeFile(statePath, JSON.stringify(state));
    const status = await runProductCritic(await p.workspace.state(), {
      operation: "status",
      task: "T003",
    });
    expect(status).toMatchObject({
      ok: true,
      value: {
        enabled,
        callsUsed: 1,
        callsRemaining: 0,
        featureBudget: { scope: "feature", callsUsed: 1, callsRemaining: 0 },
      },
    });
    if (enabled)
      expect(status).toMatchObject({
        ok: true,
        value: { next: "unresolved", stopped: expect.stringContaining("unconfigured") },
      });
    if (status.ok) expect(status.value).not.toHaveProperty("config");
    const preflight = await runProductCritic(await p.workspace.state(), {
      operation: "preflight",
      task: "T003",
    });
    expect(preflight).toMatchObject({
      ok: true,
      value: {
        ready: false,
        callsUsed: 1,
        callsRemaining: 0,
        status: enabled ? "setup-needed" : "unavailable",
        featureBudget: { scope: "feature", callsUsed: 1, callsRemaining: 0 },
      },
    });
    if (!enabled)
      expect(
        await runProductCritic(await p.workspace.state(), {
          operation: "preflight",
          task: "T001",
        }),
      ).toMatchObject({ ok: true, value: { ready: false, callsUsed: 1, callsRemaining: 0 } });
  },
);

it("passes the pinned feature limit to both host inspection and dispatch", async () => {
  const p = await setup();
  const statePath = productStatePath(await p.workspace.state(), p.brief.feature);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.criticDefault = preset;
  await writeFile(statePath, JSON.stringify(state));
  const inspect = vi.fn(async () => capabilities);
  const review = vi.fn(async () => {
    throw new Error("Controlled transport failure");
  });
  await runProductCritic(
    await p.workspace.state(),
    {
      operation: "review",
      task: "T003",
      sourceOnly: true,
    },
    { inspect, review },
  );
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ maxCalls: 1 }));
  expect(review).toHaveBeenCalledExactlyOnceWith(
    expect.anything(),
    expect.objectContaining({ maxCalls: 1 }),
  );
});
