import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { vispError } from "../../../../src/core/errors.js";
import { hashValue } from "../../../../src/core/hash.js";
import { err, ok } from "../../../../src/core/result.js";
import { snapshotSourceFiles } from "../../../../src/workflow/product/source-snapshot.js";
import {
  productImplementationDigest,
  productSourceDigest,
  productSourceSnapshot,
} from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";
import {
  sequentialProductSourceSnapshot,
  sequentialSnapshotSourceFiles,
} from "../../support/sequential-product-snapshot.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
let outside: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
  if (outside) await rm(outside, { recursive: true, force: true });
  outside = undefined;
});

async function fixture() {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  await setup.workspace.write("nested/deep/binary.dat", Buffer.from([0, 255, 192, 128, 13]));
  await setup.workspace.write("nested/deep/large.dat", Buffer.alloc(2 * 1024 * 1024, 254));
  await setup.workspace.write(".visp/declared.txt", "explicit managed input");
  outside = await mkdtemp(join(tmpdir(), "visp-snapshot-outside-"));
  await writeFile(join(outside, "file"), "outside untouched");
  await symlink("deep/binary.dat", join(state.paths.root, "nested/inside"));
  await symlink(join(outside, "file"), join(state.paths.root, "nested/outside"));
  await symlink("missing", join(state.paths.root, "nested/dangling"));
  const brief = {
    ...setup.brief,
    checks: setup.brief.checks.map((check) => ({
      ...check,
      files: [...check.files, ".visp/declared.txt", "missing.txt"],
    })),
    slices: setup.brief.slices.map((slice) => ({
      ...slice,
      scope: { ...slice.scope, allowed: ["**"] },
    })),
  };
  return { state, brief };
}

it("matches sequential keys, values, order and every snapshot-derived digest", async () => {
  const { state, brief } = await fixture();
  const before = await sequentialProductSourceSnapshot(state, brief);
  const after = await productSourceSnapshot(state, brief);
  expect(after).toEqual(before);
  if (!before.ok || !after.ok) throw new Error("fixture must snapshot successfully");
  expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
  expect(hashValue(after.value)).toBe(hashValue(before.value));
  expect(productImplementationDigest(state, after.value)).toBe(
    productImplementationDigest(state, before.value),
  );
  expect(await productSourceDigest(state, brief, after.value)).toEqual(
    await productSourceDigest(state, brief, before.value),
  );
  expect(await productSourceSnapshot(state, brief)).toEqual(after);
  expect(await readFile(join(outside ?? "", "file"), "utf8")).toBe("outside untouched");
});

it("reports the same per-file budget overflow without reading oversized inputs", async () => {
  const { state, brief } = await fixture();
  await setup.workspace.write("a-oversized.dat", "");
  await truncate(join(state.paths.root, "a-oversized.dat"), 64 * 1024 * 1024 + 1);
  const before = await sequentialProductSourceSnapshot(state, brief);
  expect(before).toMatchObject({
    ok: false,
    error: { message: "Product evidence input budget exceeded at a-oversized.dat" },
  });
  expect(await productSourceSnapshot(state, brief)).toEqual(before);
});

it("keeps total-byte budget errors ahead of a later speculative read error", async () => {
  const { state, brief } = await fixture();
  for (let index = 0; index < 9; index++) await setup.workspace.write(`a-budget-${index}`, "small");
  const metadata = state.files.readMetadata.bind(state.files);
  const read = state.files.readBytesIfExists.bind(state.files);
  const bytes = Buffer.alloc(64 * 1024 * 1024);
  vi.spyOn(state.files, "readMetadata").mockImplementation(async (path) =>
    path.startsWith("a-budget-")
      ? ok({ type: "file", mode: 0o644, size: bytes.length })
      : metadata(path),
  );
  vi.spyOn(state.files, "readBytesIfExists").mockImplementation(async (path) =>
    path === "a-budget-7"
      ? err(vispError("IO_ERROR", "later read failed"))
      : path.startsWith("a-budget-")
        ? ok(bytes)
        : read(path),
  );
  const before = await sequentialProductSourceSnapshot(state, brief);
  expect(before).toMatchObject({
    ok: false,
    error: { message: "Product evidence input budget exceeded at a-budget-7" },
  });
  expect(await productSourceSnapshot(state, brief)).toEqual(before);
});

it.each(["external", "dangling", "managed"])(
  "preserves refusal for a %s parent symlink",
  async (kind) => {
    const { state, brief } = await fixture();
    await mkdir(join(state.paths.root, ".visp/linked-dir"));
    const target =
      kind === "external"
        ? (outside ?? "/outside/project")
        : kind === "dangling"
          ? "absent-dir"
          : ".visp/linked-dir";
    await symlink(target, join(state.paths.root, "parent-link"));
    const declared = {
      ...brief,
      checks: brief.checks.map((check) => ({
        ...check,
        files: [...check.files, "parent-link/file"],
      })),
    };
    const before = await sequentialProductSourceSnapshot(state, declared);
    expect(before.ok).toBe(false);
    expect(await productSourceSnapshot(state, declared)).toEqual(before);
  },
);

it("keeps entry-budget accounting identical with at most 24 concurrent reads", async () => {
  const { state } = await fixture();
  vi.spyOn(state.files, "readSymbolicLink").mockResolvedValue(ok(undefined));
  vi.spyOn(state.files, "readMetadata").mockResolvedValue(ok(undefined));
  let active = 0;
  let peak = 0;
  vi.spyOn(state.files, "readBytesIfExists").mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return ok(undefined);
  });
  const paths = Array.from(
    { length: 20001 },
    (_, index) => `file-${String(index).padStart(5, "0")}`,
  );
  const objects = { entries: new Map(), dirty: new Set<string>() };
  const before = await sequentialSnapshotSourceFiles(state, paths, ["**"], objects, "sha1");
  expect(peak).toBe(1);
  peak = 0;
  expect(
    await state.files.withReadPass(() =>
      snapshotSourceFiles(state, paths, ["**"], objects, "sha1"),
    ),
  ).toEqual(before);
  expect(before).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("at file-20000;") },
  });
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(24);
});

it("preserves link byte accounting and inspection errors after exhausting the byte budget", async () => {
  const { state } = await fixture();
  const bytes = Buffer.alloc(64 * 1024 * 1024);
  vi.spyOn(state.files, "readSymbolicLink").mockImplementation(async (path) =>
    path === "link"
      ? ok(Buffer.from("target"))
      : path === "unsupported"
        ? err(vispError("IO_ERROR", "inspection failed"))
        : ok(undefined),
  );
  vi.spyOn(state.files, "readMetadata").mockResolvedValue(
    ok({ type: "file", mode: 0o644, size: bytes.length }),
  );
  vi.spyOn(state.files, "readBytesIfExists").mockResolvedValue(ok(bytes));
  const paths = [
    ...Array.from({ length: 8 }, (_, index) => `file-${index}`),
    "link",
    "unsupported",
  ];
  const objects = { entries: new Map(), dirty: new Set<string>() };
  const before = await sequentialSnapshotSourceFiles(state, paths, ["**"], objects, "sha1");
  expect(before).toEqual(err(vispError("IO_ERROR", "inspection failed")));
  expect(
    await state.files.withReadPass(() =>
      snapshotSourceFiles(state, paths, ["**"], objects, "sha1"),
    ),
  ).toEqual(before);
});
