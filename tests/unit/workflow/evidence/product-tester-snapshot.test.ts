import { chmod, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import {
  captureTesterSnapshot,
  inTesterSnapshot,
  type TesterSnapshot,
} from "../../../../src/workflow/product/tester-snapshot.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>>;
let snapshot: TesterSnapshot | undefined;
afterEach(async () => {
  await snapshot?.dispose();
  snapshot = undefined;
  await project?.workspace.destroy();
});

async function capture() {
  const state = await project.workspace.state();
  const sources = await productSourceSnapshot(state, project.brief);
  if (!sources.ok) throw new Error(sources.error.message);
  return captureTesterSnapshot(state, project.brief, hashValue(sources.value));
}

it("captures uncommitted, untracked and declared ignored bytes, modes and deletions", async () => {
  project = await productWorkspace();
  const w = project.workspace;
  await w.write("src/value.mjs", "export const value = 7;\n");
  await w.write("run.sh", "#!/bin/sh\necho seven\n");
  await chmod(join(w.root, "run.sh"), 0o755);
  await w.write("asset.bin", new Uint8Array([0, 255, 128]));
  await w.write(".gitignore", "ignored/\n");
  await w.write("ignored/data", "launch input");
  const check = project.brief.checks[0];
  if (!check) throw new Error("Missing check");
  check.files.push("ignored/data");
  await rm(join(w.root, "test/value.test.mjs"));
  const index = w.git("ls-files", "--stage");
  const result = await capture();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  snapshot = result.value;
  await w.write("src/value.mjs", "export const value = 8;\n");
  expect(await readFile(join(snapshot.root, "src/value.mjs"), "utf8")).toContain("value = 7");
  expect(await readFile(join(snapshot.root, "asset.bin"))).toEqual(Buffer.from([0, 255, 128]));
  expect(await readFile(join(snapshot.root, "ignored/data"), "utf8")).toBe("launch input");
  if (process.platform !== "win32")
    expect((await stat(join(snapshot.root, "run.sh"))).mode & 0o777).toBe(0o755);
  for (const path of ["test/value.test.mjs", ".git", ".visp"])
    await expect(stat(join(snapshot.root, path))).rejects.toThrow();
  expect(w.git("ls-files", "--stage")).toBe(index);
});

it.skipIf(process.platform === "win32")(
  "keeps relative and absolute project symlinks inside each execution copy",
  async () => {
    project = await productWorkspace();
    await symlink("src/value.mjs", join(project.workspace.root, "relative.mjs"));
    await symlink(
      join(project.workspace.root, "src/value.mjs"),
      join(project.workspace.root, "absolute.mjs"),
    );
    const result = await capture();
    if (!result.ok) throw new Error(result.error.message);
    snapshot = result.value;
    expect(await readlink(join(snapshot.root, "absolute.mjs"))).toBe("src/value.mjs");
    let executed = "";
    await expect(
      inTesterSnapshot(snapshot, async (root) => {
        executed = root;
        await writeFile(join(root, "absolute.mjs"), "changed only here");
        expect(await readFile(join(root, "relative.mjs"), "utf8")).toBe("changed only here");
        throw new Error("test failed");
      }),
    ).rejects.toThrow("test failed");
    await expect(stat(executed)).rejects.toThrow();
    await inTesterSnapshot(snapshot, async (root) => {
      expect(await readFile(join(root, "absolute.mjs"), "utf8")).toContain("value = 1");
    });
    expect(await readFile(join(project.workspace.root, "src/value.mjs"), "utf8")).toContain(
      "value = 1",
    );
  },
);

it("copies working bytes when Git normalizes a tracked file's line endings", async () => {
  project = await productWorkspace();
  await project.workspace.write(".gitattributes", "notes.txt text eol=crlf\n");
  await project.workspace.write("notes.txt", "first\r\nsecond\r\n");
  project.workspace.git("add", ".gitattributes", "notes.txt");
  const result = await capture();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  snapshot = result.value;
  expect(await readFile(join(snapshot.root, "notes.txt"), "utf8")).toBe("first\r\nsecond\r\n");
});

it.skipIf(process.platform === "win32")(
  "refuses links to live files outside the product copy",
  async () => {
    project = await productWorkspace();
    await symlink("../live-file", join(project.workspace.root, "external"));
    const result = await capture();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED", message: expect.stringContaining("symlink external") },
    });
  },
);
