import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";
import { applyMigration, previewMigration } from "../../../src/migration/operations.js";
import { runProductVerify, runProductWork } from "../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { productWorkspace } from "../support/product-workspace.js";
import type { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => workspace?.destroy());

it("creates product state that the previous runtime's version-two parser cannot accept", async () => {
  const setup = await productWorkspace();
  workspace = setup.workspace;
  const record = await readProductRecord(await workspace.state());
  expect(record.ok && record.value.state.version).toBe(3);
});

it("requires explicit backed-up version-two migration, preserving failed evidence and repeating without changes", async () => {
  const setup = await productWorkspace();
  workspace = setup.workspace;
  expect((await runProductWork(await workspace.state())).ok).toBe(true);
  const failed = await runProductVerify(await workspace.state());
  expect(failed.ok && failed.value.passed).toBe(false);
  const path = `.visp/features/${setup.brief.feature}/product-state.json`;
  const original = {
    ...JSON.parse(await readFile(join(workspace.root, path), "utf8")),
    version: 2,
  };
  const bytes = `${JSON.stringify(original, null, 2)}\n`;
  await workspace.write(path, bytes);
  expect(await readProductRecord(await workspace.state())).toMatchObject({
    ok: false,
    error: { code: "MIGRATION_REQUIRED" },
  });
  const before = await collectMigrationHistory(workspace.root);
  const preview = await previewMigration(workspace.root);
  expect(preview.ok).toBe(true);
  expect(await collectMigrationHistory(workspace.root)).toEqual(before);
  const applied = await applyMigration(workspace.root);
  if (!applied.ok || !("backup" in applied.value) || !applied.value.backup)
    throw new Error("Missing migration backup");
  expect(JSON.parse(await readFile(join(workspace.root, applied.value.backup), "utf8"))).toEqual(
    before.ok ? before.value : null,
  );
  const migrated = JSON.parse(await readFile(join(workspace.root, path), "utf8"));
  expect(migrated.version).toBe(3);
  expect(migrated.executions).toEqual(original.executions);
  expect(migrated.reviews).toEqual(original.reviews);
  expect(migrated.slices).toEqual(original.slices);
  expect(migrated.status).toBe(original.status);
  expect((await readProductRecord(await workspace.state())).ok).toBe(true);
  expect(await applyMigration(workspace.root)).toMatchObject({ ok: true, value: { changed: 0 } });
});

it.each([{ version: 2, slices: null }, { version: 99 }])(
  "refuses invalid or unknown state without rewriting history: %j",
  async (override) => {
    const setup = await productWorkspace();
    workspace = setup.workspace;
    const path = `.visp/features/${setup.brief.feature}/product-state.json`;
    const current = JSON.parse(await readFile(join(workspace.root, path), "utf8"));
    await workspace.write(path, JSON.stringify({ ...current, ...override }));
    const before = await collectMigrationHistory(workspace.root);
    expect(await previewMigration(workspace.root)).toMatchObject({ ok: false });
    expect(await applyMigration(workspace.root)).toMatchObject({ ok: false });
    expect(await collectMigrationHistory(workspace.root)).toEqual(before);
  },
);
