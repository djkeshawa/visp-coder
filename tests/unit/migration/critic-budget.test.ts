import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { balancedCritic } from "../../../src/config/critic.js";
import * as transactions from "../../../src/core/file-transaction.js";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";
import { applyMigration, previewMigration } from "../../../src/migration/operations.js";
import { runProductCritic } from "../../../src/workflow/product/critic.js";
import { readCriticBudgetHistory } from "../../../src/workflow/product/critic-budget-history.js";
import { criticSelection } from "../../../src/workflow/product/critic-store.js";
import { productStatePath } from "../../../src/workflow/product/store.js";
import { productWorkspace } from "../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
async function historicalBudget(version: 2 | 3 = 3) {
  const p = await productWorkspace({ critic: true });
  projects.push(p);
  const preset = balancedCritic("codex");
  if (!preset) throw new Error("preset missing");
  const config = { ...preset, maxCalls: 2 };
  const workspace = await p.workspace.state();
  expect(
    (await runProductCritic(workspace, { operation: "configure", task: "T001", config })).ok,
  ).toBe(true);
  const prepared = await runProductCritic(workspace, {
    operation: "prepare",
    task: "T001",
    sourceOnly: true,
    capabilities: {
      harness: "codex",
      model: config.model,
      reasoningEffort: "high",
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  expect(
    (
      await runProductCritic(await p.workspace.state(), {
        operation: "submit",
        task: "T001",
        attempt: (prepared.value as { attempt: string }).attempt,
        failure: "Transport ended without a known result",
        failureKind: "invocation-failed",
      })
    ).ok,
  ).toBe(true);
  const statePath = productStatePath(workspace, p.brief.feature);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.version = version;
  delete state.criticBudgetVersion;
  await writeFile(statePath, JSON.stringify(state));
  const ledger = join(workspace.paths.featureDir(p.brief.feature), "critic-budget.json");
  await rm(ledger);
  return {
    ...p,
    ledger,
    statePath,
    config,
    attempt: (prepared.value as { attempt: string }).attempt,
  };
}
it.each([2, 3] as const)(
  "previews and backs up version-%s spending before adopting the shared budget",
  async (version) => {
    const p = await historicalBudget(version);
    const before = await collectMigrationHistory(p.workspace.root);
    expect(await previewMigration(p.workspace.root)).toMatchObject({
      ok: true,
      value: {
        features: [
          expect.objectContaining({
            status: "history-upgraded",
            criticBudget: {
              version: 1,
              callsUsed: 1,
              maxCalls: 2,
              reservedMs: 180_000,
            },
          }),
        ],
      },
    });
    expect(await collectMigrationHistory(p.workspace.root)).toEqual(before);
    const applied = await applyMigration(p.workspace.root);
    if (!applied.ok || !applied.value.backup) throw new Error("budget backup missing");
    expect(
      JSON.parse(await readFile(join(p.workspace.root, applied.value.backup), "utf8")),
    ).toEqual(before.ok ? before.value : null);
    expect(JSON.parse(await readFile(p.ledger, "utf8"))).toMatchObject({
      version: 1,
      maxCalls: 2,
      entries: [expect.objectContaining({ reservedMs: 180_000 })],
    });
    expect(JSON.parse(await readFile(p.statePath, "utf8"))).toMatchObject({
      criticBudgetVersion: 1,
    });
    expect(await applyMigration(p.workspace.root)).toMatchObject({
      ok: true,
      value: { changed: 0 },
    });
    expect(
      await runProductCritic(await p.workspace.state(), { operation: "status", task: "T001" }),
    ).toMatchObject({ ok: true, value: { callsUsed: 1, callsRemaining: 1 } });
  },
);

it("requires backed-up migration before spending from a historical feature", async () => {
  const p = await historicalBudget();
  const before = await collectMigrationHistory(p.workspace.root);
  const reserve = () =>
    p.workspace.state().then((workspace) =>
      runProductCritic(workspace, {
        operation: "prepare",
        task: "T001",
        sourceOnly: true,
        retryAfter: p.attempt,
        reason: "Authorize another call after transport failure",
        capabilities: {
          harness: "codex",
          model: p.config.model,
          reasoningEffort: "high",
          freshContext: true,
          images: true,
          readOnly: true,
          delegationAllowed: true,
        },
      }),
    );
  expect(await reserve()).toMatchObject({ ok: false, error: { code: "MIGRATION_REQUIRED" } });
  expect(await collectMigrationHistory(p.workspace.root)).toEqual(before);
  expect((await applyMigration(p.workspace.root)).ok).toBe(true);
  expect((await reserve()).ok).toBe(true);
});

it("recovers an interrupted budget upgrade with its original history backup", async () => {
  const p = await historicalBudget();
  const before = await collectMigrationHistory(p.workspace.root);
  const original = transactions.applyFileTransaction;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce((root, label, mutations) =>
    original(root, label, mutations, {
      leavePreparedOnError: true,
      afterMutation: () => {
        throw new Error("interrupted budget upgrade");
      },
    }),
  );
  expect(await applyMigration(p.workspace.root)).toMatchObject({ ok: false });
  vi.restoreAllMocks();
  const applied = await applyMigration(p.workspace.root);
  if (!applied.ok || !applied.value.backup) throw new Error("backup missing after recovery");
  expect(JSON.parse(await readFile(join(p.workspace.root, applied.value.backup), "utf8"))).toEqual(
    before.ok ? before.value : null,
  );
  expect(JSON.parse(await readFile(p.ledger, "utf8"))).toMatchObject({
    maxCalls: 2,
    entries: [expect.objectContaining({ reservedMs: 180_000 })],
  });
});
it("serializes concurrent upgrades without creating fresh spending capacity", async () => {
  const p = await historicalBudget();
  const results = await Promise.all([
    applyMigration(p.workspace.root),
    applyMigration(p.workspace.root),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(results.filter((result) => result.ok && result.value.changed === 0)).toHaveLength(1);
  expect(
    await runProductCritic(await p.workspace.state(), { operation: "status", task: "T001" }),
  ).toMatchObject({ ok: true, value: { callsUsed: 1, callsRemaining: 1 } });
});
it("keeps finding-driven reopening when budget and finding history migrate together", async () => {
  const p = await historicalBudget();
  const state = JSON.parse(await readFile(p.statePath, "utf8"));
  const reviews = [
    {
      task: "T001",
      subjectDigest: "historical-subject",
      contractDigest: "historical-contract",
      createdAt: "2026-09-21T00:00:00Z",
      captures: [],
      assessments: [],
      feedback: {
        phase: "product",
        dimensions: [],
        resolutions: [],
        findings: [
          {
            dimension: "functional",
            required: true,
            problem: "Reset retains old state",
            outcomes: ["O001"],
            evidence: [],
            nextCheck: "Reset after changing value",
          },
        ],
      },
    },
  ];
  // A cross-owner collision is what triggers the existing finding identity upgrade.
  state.reviews = [...reviews, { ...reviews[0], task: undefined }];
  state.status = "accepted";
  state.acceptedSubject = "historical-subject";
  state.slices.T001.status = "closed";
  await writeFile(p.statePath, JSON.stringify(state));
  expect((await applyMigration(p.workspace.root)).ok).toBe(true);
  const migrated = JSON.parse(await readFile(p.statePath, "utf8"));
  expect(migrated).toMatchObject({
    status: "active",
    criticBudgetVersion: 1,
    slices: { T001: { status: "pending" } },
    reviews: JSON.parse(JSON.stringify(state.reviews)),
  });
  expect(migrated).not.toHaveProperty("acceptedSubject");
  expect(JSON.parse(await readFile(p.ledger, "utf8"))).toMatchObject({
    maxCalls: 2,
    entries: [expect.objectContaining({ reservedMs: 180_000 })],
  });
});

it("preserves a materialized explicit limit before any calls were made", async () => {
  const p = await historicalBudget();
  const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const state = JSON.parse(await readFile(selected.value.path, "utf8"));
  state.attempts = [];
  await writeFile(selected.value.path, JSON.stringify(state));
  expect(await previewMigration(p.workspace.root)).toMatchObject({
    ok: true,
    value: {
      features: [
        expect.objectContaining({
          status: "history-upgraded",
          criticBudget: { version: 1, callsUsed: 0, maxCalls: 2, reservedMs: 0 },
        }),
      ],
    },
  });
  expect((await applyMigration(p.workspace.root)).ok).toBe(true);
  expect(JSON.parse(await readFile(p.ledger, "utf8"))).toMatchObject({ maxCalls: 2, entries: [] });
});
it("refuses adoption when a historical input changes after planning", async () => {
  const p = await historicalBudget();
  const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const changed = JSON.parse(await readFile(selected.value.path, "utf8"));
  changed.config.timeoutMs = 300_000;
  const original = transactions.applyFileTransaction;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce(
    async (root, label, mutations) => {
      await writeFile(selected.value.path, JSON.stringify(changed));
      return original(root, label, mutations);
    },
  );
  expect(await applyMigration(p.workspace.root)).toMatchObject({ ok: false });
  await expect(readFile(p.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(selected.value.path, "utf8"))).toEqual(changed);
  expect(JSON.parse(await readFile(p.statePath, "utf8"))).not.toHaveProperty("criticBudgetVersion");
});

it("retains spending after relocation without granting the old checkout's review authority", async () => {
  const original = await historicalBudget();
  expect((await applyMigration(original.workspace.root)).ok).toBe(true);
  const relocated = await productWorkspace({ critic: true });
  projects.push(relocated);
  const from = await original.workspace.state();
  const to = await relocated.workspace.state();
  await cp(
    from.paths.featureDir(original.brief.feature),
    to.paths.featureDir(relocated.brief.feature),
    { recursive: true },
  );
  const ledger = join(to.paths.featureDir(relocated.brief.feature), "critic-budget.json");
  const originalLedger = await readFile(original.ledger, "utf8");
  expect(
    await runProductCritic(await relocated.workspace.state(), {
      operation: "status",
      task: "T001",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      callsRemaining: 1,
      next: "unresolved",
      stopped: expect.stringContaining("unconfigured"),
    },
  });
  expect(await readFile(ledger, "utf8")).toBe(originalLedger);
  expect(
    (
      await runProductCritic(await relocated.workspace.state(), {
        operation: "configure",
        task: "T001",
        config: original.config,
      })
    ).ok,
  ).toBe(true);
  expect(
    await runProductCritic(await relocated.workspace.state(), {
      operation: "status",
      task: "T001",
    }),
  ).toMatchObject({
    ok: true,
    value: {
      callsUsed: 1,
      callsRemaining: 1,
      selectionCallsUsed: 0,
      assessmentCurrent: false,
    },
  });
  const prepared = await runProductCritic(await relocated.workspace.state(), {
    operation: "prepare",
    task: "T001",
    sourceOnly: true,
    capabilities: {
      harness: "codex",
      model: original.config.model,
      reasoningEffort: "high",
      freshContext: true,
      images: true,
      readOnly: true,
      delegationAllowed: true,
    },
  });
  expect(prepared.ok).toBe(true);
  expect(
    await runProductCritic(await relocated.workspace.state(), {
      operation: "status",
      task: "T001",
    }),
  ).toMatchObject({ ok: true, value: { callsUsed: 2, callsRemaining: 0 } });
});

it.each(["malformed-json", "invalid-state", "directory"] as const)(
  "refuses budget adoption from %s history without granting spending capacity",
  async (condition) => {
    const p = await historicalBudget();
    const selected = await criticSelection(await p.workspace.state(), { task: "T001" });
    if (!selected.ok) throw new Error(selected.error.message);
    const path = selected.value.path;
    if (condition === "directory") {
      await rm(path);
      await mkdir(path);
    } else await writeFile(path, condition === "malformed-json" ? "{unfinished" : "{}");
    const before = await collectMigrationHistory(p.workspace.root);
    const stateBefore = await readFile(p.statePath, "utf8");
    expect(await previewMigration(p.workspace.root)).toMatchObject({ ok: false });
    expect(await applyMigration(p.workspace.root)).toMatchObject({ ok: false });
    expect(await collectMigrationHistory(p.workspace.root)).toEqual(before);
    expect(await readFile(p.statePath, "utf8")).toBe(stateBefore);
    await expect(readFile(p.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("retains a history precondition when the input disappears between reading bytes and metadata", async () => {
  const p = await historicalBudget();
  const workspace = await p.workspace.state();
  const selected = await criticSelection(workspace, { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const path = selected.value.path;
  const metadata = workspace.files.metadata.bind(workspace.files);
  vi.spyOn(workspace.files, "metadata").mockImplementationOnce(async (requested) => {
    await rm(path);
    return metadata(requested);
  });
  const history = await readCriticBudgetHistory(workspace, path);
  if (!history.ok) throw new Error(history.error.message);
  expect(history.value.state.attempts).toHaveLength(1);
  expect(
    await transactions.applyFileTransaction(workspace.paths.root, "test history race", [
      history.value.guard,
    ]),
  ).toMatchObject({ ok: false });
  await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(p.ledger, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
