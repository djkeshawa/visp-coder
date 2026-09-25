import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import * as transactions from "../../../src/core/file-transaction.js";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";
import { applyMigration, previewMigration } from "../../../src/migration/operations.js";
import { updateProductBrief } from "../../../src/workflow/product/brief.js";
import { runProductCritic } from "../../../src/workflow/product/critic.js";
import { runProductVerify } from "../../../src/workflow/product/evidence.js";
import { outstandingFeedback } from "../../../src/workflow/product/findings.js";
import { runProductMigrate } from "../../../src/workflow/product/migration.js";
import { readProductRecord, saveProductState } from "../../../src/workflow/product/store.js";
import { productWorkspace } from "../support/product-workspace.js";

const projects: Awaited<ReturnType<typeof productWorkspace>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of projects.splice(0)) await p.workspace.destroy();
});
async function fixture(status: "active" | "accepted" | "historical-complete" = "accepted") {
  const p = await productWorkspace();
  projects.push(p);
  const state = await p.workspace.state();
  const first = p.brief.slices[0];
  if (!first) throw new Error("Missing slice");
  const updated = await updateProductBrief(state, {
    brief: { ...p.brief, slices: [first, { ...first, id: "T002" }] },
    reason: "Second slice",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const loaded = await readProductRecord(state);
  if (!loaded.ok) throw new Error(loaded.error.message);
  const record = loaded.value;
  const review = {
    task: "T001",
    subjectDigest: "historical-subject",
    contractDigest: "historical-contract",
    createdAt: "2026-09-21T00:00:00Z",
    captures: [],
    assessments: [],
    feedback: {
      phase: "product" as const,
      dimensions: [],
      resolutions: [],
      findings: [
        {
          dimension: "functional" as const,
          required: true,
          problem: "Reset retains old state",
          outcomes: ["O001"],
          evidence: [],
          nextCheck: "Reset after changing value",
        },
      ],
    },
  };
  record.state.reviews = [review];
  const oldId = outstandingFeedback(record)[0]?.id;
  if (!oldId) throw new Error("Missing identity");
  record.state.reviews.push({ ...review, task: "T002" });
  record.state.reviews.push({
    ...review,
    task: undefined,
    feedback: {
      ...review.feedback,
      findings: [],
      resolutions: [{ id: oldId, explanation: "Reset fixed", evidence: ["historical-pass"] }],
    },
  });
  record.state.status = status;
  record.state.acceptedSubject = "historical-subject";
  record.state.acceptedContract = "historical-contract";
  record.state.acceptedReviewPolicy = 4;
  for (const slice of Object.values(record.state.slices)) slice.status = "closed";
  const saved = await saveProductState(state, record, record.state);
  if (!saved.ok) throw new Error(saved.error.message);
  const persisted = await readProductRecord(state);
  if (!persisted.ok) throw new Error(persisted.error.message);
  return {
    p,
    state,
    record: persisted.value,
    oldId,
    reportPath: state.paths.featureFile(p.brief.feature, "finding-identity-migration.json"),
  };
}

it("previews collision identities and ambiguous resolutions without changing history", async () => {
  const f = await fixture();
  const before = await collectMigrationHistory(f.p.workspace.root);
  expect(await previewMigration(f.p.workspace.root)).toMatchObject({
    ok: true,
    value: {
      features: [
        {
          status: "history-upgraded",
          findingIdentity: {
            version: 1,
            aliases: [
              { legacyId: f.oldId, task: "T001" },
              { legacyId: f.oldId, task: "T002" },
            ],
            ambiguousResolutions: [{ reviewIndex: 2, id: f.oldId, reason: "missing-owner" }],
            requiresFreshAcceptance: true,
            reopenedSlices: ["T001", "T002"],
          },
        },
      ],
    },
  });
  expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
});

it.each([2, 3])(
  "backs up version %i accepted history, reopens affected work, and applies only once",
  async (version) => {
    const f = await fixture();
    await f.p.workspace.write(
      f.state.paths.relative(f.state.paths.featureFile(f.p.brief.feature, "product-state.json")) ??
        "missing",
      JSON.stringify({ ...f.record.state, version }),
    );
    const before = await collectMigrationHistory(f.p.workspace.root);
    const applied = await applyMigration(f.p.workspace.root);
    if (!applied.ok || !applied.value.backup) throw new Error("Missing migration backup");
    expect(
      JSON.parse(await readFile(join(f.p.workspace.root, applied.value.backup), "utf8")),
    ).toEqual(before.ok ? before.value : undefined);
    const after = await readProductRecord(await f.p.workspace.state());
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.state).toMatchObject({
      status: "active",
      slices: { T001: { status: "pending" }, T002: { status: "pending" } },
    });
    expect(after.value.state.acceptedSubject).toBeUndefined();
    expect(after.value.state.acceptedContract).toBeUndefined();
    expect(after.value.state.acceptedReviewPolicy).toBeUndefined();
    expect(after.value.state.reviews).toEqual(f.record.state.reviews);
    expect(after.value.state.executions).toEqual(f.record.state.executions);
    expect(JSON.parse(await readFile(f.reportPath, "utf8"))).toMatchObject({
      version: 1,
      previousAcceptance: {
        status: "accepted",
        subject: "historical-subject",
        contract: "historical-contract",
        reviewPolicy: 4,
      },
    });
    expect(await applyMigration(f.p.workspace.root)).toMatchObject({
      ok: true,
      value: { changed: 0 },
    });
  },
);

it("preserves explicitly historical completion without granting fresh approval", async () => {
  const f = await fixture("historical-complete");
  expect(await applyMigration(f.p.workspace.root)).toMatchObject({ ok: true });
  const after = await readProductRecord(await f.p.workspace.state());
  expect(after.ok && after.value.state).toEqual(f.record.state);
  expect(JSON.parse(await readFile(f.reportPath, "utf8"))).toMatchObject({
    requiresFreshAcceptance: true,
    reopenedSlices: [],
    previousAcceptance: { status: "historical-complete" },
  });
});

it("refuses an unsupported identity migration report without changing files", async () => {
  const f = await fixture();
  await f.p.workspace.write(f.state.paths.relative(f.reportPath) ?? "missing", '{"version":99}');
  const before = await collectMigrationHistory(f.p.workspace.root);
  expect(await applyMigration(f.p.workspace.root)).toMatchObject({ ok: false });
  expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
});

it("preserves accepted state when each historical collision was explicitly resolved by its owner", async () => {
  const f = await fixture();
  const first = f.record.state.reviews[0];
  if (!first?.feedback) throw new Error("Missing review");
  for (const task of ["T001", "T002"])
    f.record.state.reviews.push({
      ...first,
      task,
      feedback: {
        ...first.feedback,
        findings: [],
        resolutions: [
          { id: f.oldId, explanation: "Owner repaired", evidence: ["historical-pass"] },
        ],
      },
    });
  expect((await saveProductState(f.state, f.record, f.record.state)).ok).toBe(true);
  expect((await applyMigration(f.p.workspace.root)).ok).toBe(true);
  const after = await readProductRecord(await f.p.workspace.state());
  expect(after.ok && after.value.state).toEqual(f.record.state);
  expect(JSON.parse(await readFile(f.reportPath, "utf8"))).toMatchObject({
    requiresFreshAcceptance: false,
    requiredFindings: [],
    reopenedSlices: [],
  });
});

it.each([2, 3])(
  "recovers interrupted version %i identity migration with the original acceptance backup",
  async (version) => {
    const f = await fixture();
    await f.p.workspace.write(
      f.state.paths.relative(f.state.paths.featureFile(f.p.brief.feature, "product-state.json")) ??
        "missing",
      JSON.stringify({ ...f.record.state, version }),
    );
    const before = await collectMigrationHistory(f.p.workspace.root);
    const original = transactions.applyFileTransaction;
    vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce(
      (root, label, mutations) =>
        original(root, label, mutations, {
          leavePreparedOnError: true,
          afterMutation: () => {
            throw new Error("interrupted");
          },
        }),
    );
    expect(await applyMigration(f.p.workspace.root)).toMatchObject({ ok: false });
    vi.restoreAllMocks();
    const applied = await applyMigration(f.p.workspace.root);
    if (!applied.ok || !applied.value.backup) throw new Error("Missing backup");
    expect(
      JSON.parse(await readFile(join(f.p.workspace.root, applied.value.backup), "utf8")),
    ).toEqual(before.ok ? before.value : undefined);
    expect(await applyMigration(f.p.workspace.root)).toMatchObject({
      ok: true,
      value: { changed: 0 },
    });
  },
);

it("rejects altered alias mappings in a current migration report", async () => {
  const f = await fixture();
  expect((await applyMigration(f.p.workspace.root)).ok).toBe(true);
  const report = JSON.parse(await readFile(f.reportPath, "utf8"));
  report.aliases[0].task = "T999";
  await f.p.workspace.write(
    f.state.paths.relative(f.reportPath) ?? "missing",
    JSON.stringify(report),
  );
  const before = await collectMigrationHistory(f.p.workspace.root);
  expect(await applyMigration(f.p.workspace.root)).toMatchObject({ ok: false });
  expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
});

it.each([2, 3])(
  "allows version %i preview but refuses identity application while a critic owns the review window",
  async (version) => {
    const f = await fixture("active");
    const verified = await runProductVerify(f.state, { task: "T001" });
    if (!verified.ok) throw new Error(verified.error.message);
    const policy = await runProductCritic(f.state, {
      operation: "set-policy",
      enabled: true,
      harness: "codex",
    });
    if (!policy.ok) throw new Error(policy.error.message);
    const reserved = await runProductCritic(f.state, {
      operation: "prepare",
      task: "T001",
      phase: "product",
      capabilities: {
        harness: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        freshContext: true,
        images: true,
        readOnly: true,
        delegationAllowed: true,
      },
    });
    if (!reserved.ok) throw new Error(reserved.error.message);
    const path = f.state.paths.featureFile(f.p.brief.feature, "product-state.json");
    const current = JSON.parse(await readFile(path, "utf8"));
    await f.p.workspace.write(
      f.state.paths.relative(path) ?? "missing",
      JSON.stringify({ ...current, version }),
    );
    const before = await collectMigrationHistory(f.p.workspace.root);
    expect(await previewMigration(f.p.workspace.root)).toMatchObject({ ok: true });
    expect(await applyMigration(f.p.workspace.root)).toMatchObject({
      ok: false,
      error: { code: "STATE_BUSY" },
    });
    expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
  },
);

it("routes current history upgrades from the retiring adapter to backed-up standalone apply", async () => {
  const f = await fixture();
  const before = await collectMigrationHistory(f.p.workspace.root);
  expect(await runProductMigrate(f.state, { dryRun: true })).toMatchObject({ ok: true });
  expect(await runProductMigrate(f.state)).toMatchObject({
    ok: false,
    error: { code: "MIGRATION_REQUIRED", recovery: expect.stringContaining("visp-migrate") },
  });
  expect(await collectMigrationHistory(f.p.workspace.root)).toEqual(before);
});

it("delivers collision preview and backed-up apply through the built standalone CLI", async () => {
  const f = await fixture();
  async function call(operation: string) {
    const result = await promisify(execFile)(
      process.execPath,
      [resolve("dist/migrate.js"), "--project", f.p.workspace.root, operation],
      { timeout: 30000 },
    );
    return JSON.parse(result.stdout);
  }
  expect(await call("preview")).toMatchObject({
    ok: true,
    data: {
      features: [
        { status: "history-upgraded", findingIdentity: { requiresFreshAcceptance: true } },
      ],
    },
  });
  expect(await call("apply")).toMatchObject({ ok: true, data: { backup: expect.any(String) } });
  expect(await call("apply")).toMatchObject({ ok: true, data: { changed: 0 } });
  const after = await readProductRecord(await f.p.workspace.state());
  expect(after.ok && after.value.state.status).toBe("active");
});
