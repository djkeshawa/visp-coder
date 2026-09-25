import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as transactions from "../../../src/core/file-transaction.js";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";
import {
  applyMigration,
  exportMigrationHistory,
  previewMigration,
} from "../../../src/migration/operations.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { TestWorkspace } from "../support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const w of workspaces.splice(0)) await w.destroy();
});
async function fixture() {
  const w = await TestWorkspace.create({ "app.js": "export const value=1;" });
  workspaces.push(w);
  await w.withFeature("001-history", [{ allowedFiles: ["app.js"] }]);
  return w;
}
it("previews without changing history, backs up before apply and repeats without fresh evidence", async () => {
  const w = await fixture();
  const before = await collectMigrationHistory(w.root);
  expect((await previewMigration(w.root)).ok).toBe(true);
  expect(await collectMigrationHistory(w.root)).toEqual(before);
  const applied = await applyMigration(w.root);
  if (!applied.ok || !("backup" in applied.value) || !applied.value.backup)
    throw new Error("backup missing");
  expect(JSON.parse(await readFile(join(w.root, applied.value.backup), "utf8"))).toEqual(
    before.ok ? before.value : null,
  );
  expect(await applyMigration(w.root)).toMatchObject({ ok: true, value: { changed: 0 } });
  const record = await readProductRecord(await w.state(), { feature: "001-history" });
  expect(record.ok && record.value.state.executions).toEqual([]);
});
it("exports malformed state without recovering pending journals or overwriting exports", async () => {
  const w = await fixture();
  await w.write("visp.yml", "bad: [");
  await w.write(".visp/state/transactions/broken.json", "{broken");
  const before = await collectMigrationHistory(w.root);
  const exported = await exportMigrationHistory(w.root, "before-repair");
  expect(exported.ok).toBe(true);
  expect(await collectMigrationHistory(w.root)).toEqual(before);
  expect(await exportMigrationHistory(w.root, "before-repair")).toMatchObject({ ok: false });
  expect(await exportMigrationHistory(w.root, "../escape")).toMatchObject({ ok: false });
});
it("recovers interruption of the combined backup and migration transaction", async () => {
  const w = await fixture();
  const before = await collectMigrationHistory(w.root);
  const original = transactions.applyFileTransaction;
  vi.spyOn(transactions, "applyFileTransaction").mockImplementationOnce((root, label, mutations) =>
    original(root, label, mutations, {
      leavePreparedOnError: true,
      afterMutation: () => {
        throw new Error("interrupted");
      },
    }),
  );
  expect(await applyMigration(w.root)).toMatchObject({ ok: false });
  vi.restoreAllMocks();
  const applied = await applyMigration(w.root);
  if (!applied.ok || !("backup" in applied.value) || !applied.value.backup)
    throw new Error("backup missing");
  expect(JSON.parse(await readFile(join(w.root, applied.value.backup), "utf8"))).toEqual(
    before.ok ? before.value : null,
  );
});

it.each(["bugfix", "feature", undefined] as const)(
  "preserves only the recorded legacy task class: %s",
  async (taskClass) => {
    const w = await fixture();
    const path = ".visp/features/001-history/tasks.json";
    const raw = JSON.parse(await readFile(join(w.root, path), "utf8"));
    if (taskClass === undefined) delete raw.tasks[0].taskClass;
    else raw.tasks[0].taskClass = taskClass;
    const original = JSON.stringify(raw, null, 2);
    await w.write(path, original);
    expect((await previewMigration(w.root)).ok).toBe(true);
    expect(await readFile(join(w.root, path), "utf8")).toBe(original);
    expect((await applyMigration(w.root)).ok).toBe(true);
    const record = await readProductRecord(await w.state(), { feature: "001-history" });
    if (!record.ok) throw new Error(record.error.message);
    expect(record.value.brief.slices[0]?.taskClass).toBe(taskClass);
    expect(await readFile(join(w.root, path), "utf8")).toBe(original);
    expect(await applyMigration(w.root)).toMatchObject({ ok: true, value: { changed: 0 } });
  },
);

it("refuses preview and application when configuration cannot be read, preserving the original", async () => {
  const w = await fixture();
  await w.write("visp.yml", "bad: [");
  const before = await collectMigrationHistory(w.root);
  expect(await previewMigration(w.root)).toMatchObject({ ok: false });
  expect(await applyMigration(w.root)).toMatchObject({ ok: false });
  expect(await collectMigrationHistory(w.root)).toEqual(before);
});

it("refuses an unknown selected feature without upgrading a different feature", async () => {
  const w = await fixture();
  const before = await collectMigrationHistory(w.root);
  expect(await previewMigration(w.root, "999-missing")).toMatchObject({ ok: false });
  expect(await applyMigration(w.root, "999-missing")).toMatchObject({ ok: false });
  expect(await collectMigrationHistory(w.root)).toEqual(before);
});

it("does not apply migration or publish an export when original history cannot be backed up", async () => {
  const w = await fixture();
  const tasks = join(w.root, ".visp/features/001-history/tasks.json");
  const before = await readFile(tasks, "utf8");
  await symlink("../app.js", join(w.root, ".visp/linked-history"));
  expect(await previewMigration(w.root)).toMatchObject({ ok: true });
  expect(await applyMigration(w.root)).toMatchObject({ ok: false });
  expect(await exportMigrationHistory(w.root, "linked-history")).toMatchObject({ ok: false });
  expect(await readFile(tasks, "utf8")).toBe(before);
  await expect(
    readFile(join(w.root, ".visp/features/001-history/product-state.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(w.root, ".visp/exports/linked-history.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
