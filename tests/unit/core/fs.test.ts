import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exists,
  listDir,
  listDirectories,
  ProjectFileSystem,
  readJson,
  readText,
  readTextIfExists,
  removeFile,
  writeJson,
  writeTextAtomic,
} from "../../../src/core/fs.js";
import { ok } from "../../../src/core/result.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visp-fs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTextAtomic", () => {
  it("creates missing parent directories", async () => {
    const path = join(dir, "a", "b", "file.txt");
    expect((await writeTextAtomic(path, "content")).ok).toBe(true);
    expect(await exists(path)).toBe(true);
  });

  it("leaves no temporary files behind", async () => {
    await writeTextAtomic(join(dir, "file.txt"), "content");
    const entries = await listDir(dir);
    expect(entries.ok && entries.value).toEqual(["file.txt"]);
  });

  it("overwrites an existing file", async () => {
    const path = join(dir, "file.txt");
    await writeTextAtomic(path, "first");
    await writeTextAtomic(path, "second");
    const read = await readText(path);
    expect(read.ok && read.value).toBe("second");
  });
});

describe("readText", () => {
  it("reports a missing file as ARTIFACT_MISSING", async () => {
    const result = await readText(join(dir, "absent.txt"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ARTIFACT_MISSING");
  });

  it("refuses to follow a symlink", async () => {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "secret");
    await symlink(target, link);

    const result = await readText(link);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("symlink");
  });
});

describe("readTextIfExists", () => {
  it("returns undefined for an absent file", async () => {
    const result = await readTextIfExists(join(dir, "absent.txt"));
    expect(result.ok && result.value).toBeUndefined();
  });

  it("returns content when the file exists", async () => {
    await writeTextAtomic(join(dir, "file.txt"), "content");
    const result = await readTextIfExists(join(dir, "file.txt"));
    expect(result.ok && result.value).toBe("content");
  });
});

describe("readJson", () => {
  const parse = (value: unknown) => ok(value as { a: number });

  it("round-trips a written value", async () => {
    const path = join(dir, "data.json");
    await writeJson(path, { a: 1 });
    const result = await readJson(path, parse);
    expect(result.ok && result.value).toEqual({ a: 1 });
  });

  it("reports malformed JSON as ARTIFACT_INVALID", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json");
    const result = await readJson(path, parse);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ARTIFACT_INVALID");
  });
});

describe("removeFile", () => {
  it("succeeds when the file is already absent", async () => {
    expect((await removeFile(join(dir, "absent.txt"))).ok).toBe(true);
  });

  it("deletes an existing file", async () => {
    const path = join(dir, "file.txt");
    await writeTextAtomic(path, "content");
    await removeFile(path);
    expect(await exists(path)).toBe(false);
  });
});

describe("listDir", () => {
  it("returns an empty list for an absent directory", async () => {
    const result = await listDir(join(dir, "absent"));
    expect(result.ok && result.value).toEqual([]);
  });

  it("returns sorted entry names", async () => {
    await writeTextAtomic(join(dir, "b.txt"), "");
    await writeTextAtomic(join(dir, "a.txt"), "");
    const result = await listDir(dir);
    expect(result.ok && result.value).toEqual(["a.txt", "b.txt"]);
  });
});

describe("listDirectories", () => {
  it("returns only sorted real directories", async () => {
    await writeTextAtomic(join(dir, "artifact.png"), "image");
    await mkdir(join(dir, "T002"));
    await mkdir(join(dir, "T001"));
    await symlink(join(dir, "T001"), join(dir, "linked-task"));

    const result = await listDirectories(dir);

    expect(result.ok && result.value).toEqual(["T001", "T002"]);
  });

  it("returns an empty list for an absent directory", async () => {
    const result = await listDirectories(join(dir, "absent"));
    expect(result.ok && result.value).toEqual([]);
  });
});

describe("ProjectFileSystem", () => {
  it("lists contained entries with stable names and types", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, "contents", "folder"), { recursive: true });
    await writeFile(join(root, "contents", "file.txt"), "bytes");
    await symlink("file.txt", join(root, "contents", "link.txt"));

    const result = await new ProjectFileSystem(root).listEntries("contents");

    expect(result).toEqual({
      ok: true,
      value: [
        { name: "file.txt", type: "file" },
        { name: "folder", type: "directory" },
        { name: "link.txt", type: "symlink" },
      ],
    });
  });

  it("returns an empty entry list for a missing contained directory", async () => {
    const root = join(dir, "project");
    await mkdir(root);

    expect(await new ProjectFileSystem(root).listEntries("missing")).toEqual({
      ok: true,
      value: [],
    });
  });

  it("reports invalid and non-directory entry-list targets", async () => {
    const root = join(dir, "project");
    await mkdir(root);
    await writeFile(join(root, "file.txt"), "bytes");
    const files = new ProjectFileSystem(root);

    const outside = await files.listEntries(join(dir, "outside"));
    const file = await files.listEntries("file.txt");

    expect(outside.ok).toBe(false);
    expect(file.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("IO_ERROR");
    if (!file.ok) expect(file.error.code).toBe("IO_ERROR");
  });

  it("reports exact file size and distinguishes directories", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, "folder"), { recursive: true });
    await writeFile(join(root, "file.txt"), "12345");
    const files = new ProjectFileSystem(root);

    const file = await files.metadata("file.txt");
    const folder = await files.metadata("folder");
    const missing = await files.metadata("missing");

    expect(file.ok && file.value).toMatchObject({ type: "file", size: 5 });
    expect(folder.ok && folder.value).toMatchObject({ type: "directory" });
    expect(missing).toEqual({ ok: true, value: undefined });
  });

  it("writes beneath a canonicalized symlinked project root", async () => {
    const actualRoot = join(dir, "actual");
    const linkedRoot = join(dir, "linked");
    await mkdir(actualRoot);
    await symlink(actualRoot, linkedRoot, "dir");

    const files = new ProjectFileSystem(linkedRoot);
    const result = await files.writeTextAtomic(join(linkedRoot, ".visp", "status.json"), "safe");

    expect(result.ok).toBe(true);
    expect(await readFile(join(actualRoot, ".visp", "status.json"), "utf8")).toBe("safe");
  });

  it("canonicalizes an existing symlink ancestor when the project path is missing", async () => {
    const actualParent = join(dir, "actual");
    const linkedParent = join(dir, "linked");
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent, "dir");

    const files = new ProjectFileSystem(join(linkedParent, "new-project"));
    const result = await files.writeTextAtomic(".visp/status.json", "safe");

    expect(result.ok).toBe(true);
    expect(files.root).toBe(join(await realpath(actualParent), "new-project"));
    expect(await readFile(join(actualParent, "new-project", ".visp", "status.json"), "utf8")).toBe(
      "safe",
    );
  });

  it("rejects a managed write through a symlinked parent", async () => {
    const root = join(dir, "project");
    const outside = join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "unchanged");
    await symlink(outside, join(root, ".visp"), "dir");

    const result = await new ProjectFileSystem(root).writeTextAtomic(
      join(root, ".visp", "sentinel.txt"),
      "changed",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IO_ERROR");
    expect(result.error.message).toContain("symlink");
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged");
  });

  it("rejects chained and dangling symlink components", async () => {
    const root = join(dir, "project");
    const outside = join(dir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "first"), "dir");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    const files = new ProjectFileSystem(root);

    const chained = await files.writeTextAtomic(join(root, "first", "second", "file.txt"), "x");
    const dangling = await files.writeTextAtomic(join(root, "dangling", "file.txt"), "x");

    expect(chained.ok).toBe(false);
    expect(dangling.ok).toBe(false);
    if (!chained.ok) expect(chained.error.message).toContain("symlink");
    if (!dangling.ok) expect(dangling.error.message).toContain("symlink");
  });

  it("rejects paths outside the canonical project root", async () => {
    const root = join(dir, "project");
    await mkdir(root);
    const files = new ProjectFileSystem(root);

    const result = await files.writeTextAtomic(join(dir, "outside.txt"), "changed");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("IO_ERROR");
    expect(await exists(join(dir, "outside.txt"))).toBe(false);
  });

  it("rejects absolute paths from another platform instead of treating them as filenames", async () => {
    const root = join(dir, "project");
    await mkdir(root);
    const files = new ProjectFileSystem(root);

    const result = await files.writeTextAtomic("C:\\outside\\sentinel.txt", "changed");

    expect(result.ok).toBe(false);
    expect(await exists(join(root, "C:\\outside\\sentinel.txt"))).toBe(false);
  });

  it("rejects parent traversal even when normalization would remain inside the project", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, "nested"), { recursive: true });
    const files = new ProjectFileSystem(root);

    const result = await files.writeTextAtomic("nested/../target.txt", "changed");

    expect(result.ok).toBe(false);
    expect(await exists(join(root, "target.txt"))).toBe(false);
  });

  it("rejects deleting a symlink instead of treating it as a managed file", async () => {
    const root = join(dir, "project");
    const outside = join(dir, "outside.txt");
    await mkdir(root);
    await writeFile(outside, "unchanged");
    await symlink(outside, join(root, "link.txt"));

    const result = await new ProjectFileSystem(root).removeFile(join(root, "link.txt"));

    expect(result.ok).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("unchanged");
  });

  it("reads an authored source symlink when its target remains inside the project", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    await writeFile(join(root, "packages", "shared", "source.ts"), "export const safe = true;\n");
    await symlink(join(root, "packages", "shared"), join(root, "linked-source"), "dir");

    const result = await new ProjectFileSystem(root).readText("linked-source/source.ts");

    expect(result).toEqual({ ok: true, value: "export const safe = true;\n" });
  });

  it("rejects authored reads through external, dangling, or managed-state symlinks", async () => {
    const root = join(dir, "project");
    const outside = join(dir, "outside");
    await mkdir(join(root, ".visp"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, ".visp", "secret.json"), "managed");
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "external"), "dir");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    await symlink(join(root, ".visp"), join(root, "managed-alias"), "dir");
    const files = new ProjectFileSystem(root);

    const external = await files.readText("external/secret.txt");
    const dangling = await files.readText("dangling/secret.txt");
    const managed = await files.readText("managed-alias/secret.json");

    expect(external.ok).toBe(false);
    expect(dangling.ok).toBe(false);
    expect(managed.ok).toBe(false);
    if (!external.ok) expect(external.error.message).toContain("external symlink");
    if (!dangling.ok) expect(dangling.error.message).toContain("symlink");
    if (!managed.ok) expect(managed.error.message).toContain("external symlink");
  });

  it("refuses to rename the project root", async () => {
    const root = join(dir, "project");
    await mkdir(root);

    const result = await new ProjectFileSystem(root).rename(root, join(root, "moved"));

    expect(result.ok).toBe(false);
    expect(await exists(root)).toBe(true);
  });

  it("refuses to remove the project root", async () => {
    const root = join(dir, "project");
    await mkdir(root);

    const result = await new ProjectFileSystem(root).removeDir(root);

    expect(result.ok).toBe(false);
    expect(await exists(root)).toBe(true);
  });

  it("refuses to rename a contained path over the project root", async () => {
    const root = join(dir, "project");
    await mkdir(join(root, "child"), { recursive: true });

    const result = await new ProjectFileSystem(root).rename(join(root, "child"), root);

    expect(result.ok).toBe(false);
    expect(await exists(join(root, "child"))).toBe(true);
  });
});
