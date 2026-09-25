import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../../src/core/hash.js";
import { collectMigrationHistory } from "../../../src/migration/history-export.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visp-export-"));
  roots.push(root);
  await mkdir(join(root, ".visp/features/001-old/critic"), { recursive: true });
  return root;
}
it("exports raw malformed history and binary evidence without changing originals", async () => {
  const root = await fixture();
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  await writeFile(join(root, ".visp/features/001-old/image.bin"), bytes);
  await writeFile(join(root, ".visp/features/001-old/critic/state.json"), '{"unfinished":');
  await writeFile(join(root, "visp.yml"), "unknown-old-setting: true\n");
  const result = await collectMigrationHistory(root);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  const image = result.value.files.find((entry) => entry.path.endsWith("image.bin"));
  expect(image?.sha256).toBe(sha256(bytes));
  expect(Buffer.from(image?.contentBase64 ?? "", "base64")).toEqual(bytes);
  expect(result.value.files.map((entry) => entry.path)).toContain("visp.yml");
  expect(await readFile(join(root, ".visp/features/001-old/image.bin"))).toEqual(bytes);
  expect(await collectMigrationHistory(root)).toEqual(result);
});
it("refuses linked history rather than exporting an incomplete or escaped snapshot", async () => {
  const root = await fixture();
  await symlink("/etc/passwd", join(root, ".visp/features/001-old/linked"));
  expect(await collectMigrationHistory(root)).toMatchObject({ ok: false });
});

it("refuses an oversized history file without returning a partial archive", async () => {
  const root = await fixture();
  const path = join(root, ".visp/features/001-old/large.bin");
  await writeFile(path, "");
  await truncate(path, 32 * 1024 * 1024 + 1);
  expect(await collectMigrationHistory(root)).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("no partial export") },
  });
});

it("refuses excessively nested history without deleting any original bytes", async () => {
  const root = await fixture();
  const directory = join(root, ".visp", ...Array.from({ length: 65 }, () => "nested"));
  await mkdir(directory, { recursive: true });
  const path = join(directory, "original.txt");
  await writeFile(path, "preserved history");
  expect(await collectMigrationHistory(root)).toMatchObject({
    ok: false,
    error: { code: "ARTIFACT_INVALID", message: expect.stringContaining("depth limit") },
  });
  expect(await readFile(path, "utf8")).toBe("preserved history");
});
