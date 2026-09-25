import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { applyFileTransaction } from "../../../src/core/file-transaction.js";
import { planMigrationBackup } from "../../../src/migration/backup.js";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "visp-backup-"));
  await mkdir(join(root, ".visp/features/001-old"), { recursive: true });
  await writeFile(join(root, ".visp/features/001-old/state.json"), '{"unfinished":');
});
afterEach(async () => rm(root, { recursive: true, force: true }));

it("plans an exact private backup without writing, and reuses identical backup bytes", async () => {
  const snapshot = await collectMigrationHistory(root);
  const planned = await planMigrationBackup(root);
  if (!planned.ok || !snapshot.ok) throw new Error("Fixture backup planning failed");
  if (planned.value.mutation.kind !== "write") throw new Error("Backup must be a write");
  await expect(stat(join(root, planned.value.path))).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(Buffer.from(planned.value.mutation.content).toString("utf8"))).toEqual(
    snapshot.value,
  );
  expect(await applyFileTransaction(root, "test backup", [planned.value.mutation])).toMatchObject({
    ok: true,
  });
  const path = join(root, planned.value.path);
  const before = await readFile(path, "utf8");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const repeated = await planMigrationBackup(root);
  expect(repeated).toMatchObject({ ok: true, value: { path: planned.value.path } });
  if (!repeated.ok) throw new Error(repeated.error.message);
  if (repeated.value.mutation.kind !== "write") throw new Error("Backup must remain a write");
  expect(repeated.value.mutation.content).toBe(before);
  expect(await collectMigrationHistory(root)).toEqual(snapshot);
});

it("refuses a conflicting existing backup and preserves both history and backup", async () => {
  const planned = await planMigrationBackup(root);
  if (!planned.ok) throw new Error(planned.error.message);
  const snapshot = await collectMigrationHistory(root);
  const path = join(root, planned.value.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "original conflicting backup");
  expect(await planMigrationBackup(root)).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("refusing to replace") },
  });
  expect(await readFile(path, "utf8")).toBe("original conflicting backup");
  expect(await collectMigrationHistory(root)).toEqual(snapshot);
});

it("does not replace a backup created after the plan was prepared", async () => {
  const planned = await planMigrationBackup(root);
  if (!planned.ok) throw new Error(planned.error.message);
  const path = join(root, planned.value.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "concurrent backup");
  expect(
    await applyFileTransaction(root, "test raced backup", [planned.value.mutation]),
  ).toMatchObject({ ok: false });
  expect(await readFile(path, "utf8")).toBe("concurrent backup");
});

it("refuses an unreadable backup destination without removing it", async () => {
  const planned = await planMigrationBackup(root);
  if (!planned.ok) throw new Error(planned.error.message);
  const path = join(root, planned.value.path);
  await mkdir(path, { recursive: true });
  expect(await planMigrationBackup(root)).toMatchObject({ ok: false });
  expect((await stat(path)).isDirectory()).toBe(true);
});

it("does not plan a partial backup when history contains a linked file", async () => {
  await symlink("state.json", join(root, ".visp/features/001-old/link.json"));
  expect(await planMigrationBackup(root)).toMatchObject({ ok: false });
  await expect(stat(join(root, ".visp/migrations/backups"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
