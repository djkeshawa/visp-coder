import * as fs from "node:fs/promises";
import { chmod, rename, stat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { executeProductCheck } from "../../../../src/workflow/product/check-execution.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { sequentialProductSourceSnapshot } from "../../support/sequential-product-snapshot.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
});

it("hashes current bytes on every pass, including edits with restored mtime", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const reads = vi.spyOn(state.files, "readBytesIfExists");
  const before = await productSourceSnapshot(state, setup.brief);
  reads.mockClear();
  expect(await productSourceSnapshot(state, setup.brief)).toEqual(before);
  expect(reads.mock.calls.map(([path]) => path)).toContain("src/value.mjs");
  reads.mockClear();
  const path = join(state.paths.root, "src/value.mjs");
  const original = await stat(path);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  await utimes(path, original.atime, original.mtime);
  const changed = await productSourceSnapshot(state, setup.brief);
  expect(changed).not.toEqual(before);
  expect(reads.mock.calls.map(([path]) => path)).toContain("src/value.mjs");
});

it("detects VISP writes and check subprocess writes in the same process", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const before = await productSourceSnapshot(state, setup.brief);
  expect(
    await state.files.writeTextAtomic("src/value.mjs", "export const value = 3;\n"),
  ).toMatchObject({ ok: true });
  const written = await productSourceSnapshot(state, setup.brief);
  expect(written).not.toEqual(before);
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  const check = record.value.brief.checks[0];
  if (!check) throw new Error("Missing fixture check");
  const executed = await executeProductCheck(
    state,
    record.value,
    setup.brief.slices[0],
    {
      ...check,
      command: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync('src/value.mjs', 'export const value = 4;\\n')",
      ],
    },
    "fixture-source",
  );
  expect(executed.execution.status).toBe("passed");
  expect(await productSourceSnapshot(state, setup.brief)).not.toEqual(written);
});

it("does not reuse identities across mode changes or replacement by a link", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const before = await productSourceSnapshot(state, setup.brief);
  await chmod(join(state.paths.root, "src/value.mjs"), 0o755);
  expect(await productSourceSnapshot(state, setup.brief)).not.toEqual(before);
  expect(await state.files.removeFile("src/value.mjs")).toMatchObject({ ok: true });
  await symlink("../../external", join(state.paths.root, "src/value.mjs"));
  const linked = await productSourceSnapshot(state, setup.brief);
  expect(linked).toMatchObject({ ok: true });
  expect(linked).not.toEqual(before);
});

it("revalidates parents between passes even when entry fingerprints are unchanged", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  expect(await productSourceSnapshot(state, setup.brief)).toMatchObject({ ok: true });
  await rename(join(state.paths.root, "src"), join(state.paths.root, "original-src"));
  await symlink("original-src", join(state.paths.root, "src"));
  expect(await productSourceSnapshot(state, setup.brief)).toMatchObject({
    ok: false,
    error: {
      message: `Refusing project path with symlink component: ${join(state.paths.root, "src")}`,
    },
  });
});

it("checks a shared parent before every entry access during a read pass", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  await setup.workspace.write("src/second.mjs", "second");
  const stats = vi.mocked(fs.lstat);
  stats.mockClear();
  await state.files.withReadPass(async () => {
    for (const path of ["src/value.mjs", "src/second.mjs", "src/value.mjs"])
      expect(await state.files.readSymbolicLink(path)).toMatchObject({ ok: true });
  });
  const parent = join(state.paths.root, "src");
  expect(stats.mock.calls.filter(([path]) => path === parent)).toHaveLength(3);
});

it.each([false, true])("retains final metadata checks with a read pass: %s", async (pass) => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const target = join(state.paths.root, "src/value.mjs");
  const stats = vi.mocked(fs.lstat);
  const original = (await vi.importActual<typeof fs>("node:fs/promises")).lstat;
  let replaced = false;
  stats.mockImplementation(async (...args) => {
    const value = await original(...args);
    if (args[0] === target && !replaced) {
      replaced = true;
      await rename(target, `${target}.original`);
      await symlink("/outside/source", target);
    }
    return value;
  });
  try {
    const read = () => state.files.readMetadata("src/value.mjs");
    expect(await (pass ? state.files.withReadPass(read) : read())).toMatchObject({
      ok: false,
      error: { message: `Refusing project path with symlink component: ${target}` },
    });
  } finally {
    stats.mockImplementation(original);
  }
});

it("refreshes dirty Git identities across passes and changed input declarations", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  await setup.workspace.write("outside.txt", "original");
  const before = await productSourceSnapshot(state, setup.brief);
  const metadata = vi.spyOn(state.files, "readMetadata");
  expect(await productSourceSnapshot(state, setup.brief)).toEqual(before);
  expect(metadata.mock.calls.some(([path]) => path === "outside.txt")).toBe(true);
  await setup.workspace.write("outside.txt", "changed");
  const changed = await productSourceSnapshot(state, setup.brief);
  expect(changed).not.toEqual(before);
  expect(metadata.mock.calls.some(([path]) => path === "outside.txt")).toBe(true);
  const broad = {
    ...setup.brief,
    slices: setup.brief.slices.map((slice) => ({
      ...slice,
      scope: { ...slice.scope, allowed: ["**"] },
    })),
  };
  expect(await productSourceSnapshot(state, broad)).toEqual(
    await sequentialProductSourceSnapshot(state, broad),
  );
  expect(await productSourceSnapshot(state, setup.brief)).toEqual(
    await sequentialProductSourceSnapshot(state, setup.brief),
  );
});
