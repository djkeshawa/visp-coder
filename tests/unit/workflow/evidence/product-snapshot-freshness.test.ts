import { renameSync, symlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";
import {
  sequentialProductSourceSnapshot,
  sequentialSnapshotSourceFiles,
} from "../../support/sequential-product-snapshot.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let setup: Awaited<ReturnType<typeof productWorkspace>>;
let outside: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
  if (outside) await fs.rm(outside, { recursive: true, force: true });
  outside = undefined;
});

it.each(["external", "internal", "dangling"])(
  "matches the sequential refusal when a shared parent becomes a %s link during a pass",
  async (kind) => {
    setup = await productWorkspace();
    const state = await setup.workspace.state();
    for (let index = 0; index < 50; index++)
      await setup.workspace.write(`a-inputs/f${String(index).padStart(2, "0")}`, "old");
    const brief = {
      ...setup.brief,
      slices: setup.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: ["**"] },
      })),
    };
    const before = await sequentialProductSourceSnapshot(state, brief);
    if (!before.ok) throw new Error(before.error.message);
    const replacementEntry = Object.keys(before.value).find(
      (path, index) => index > 0 && index % 24 === 0 && path.startsWith("a-inputs/"),
    );
    expect(replacementEntry).toBeDefined();
    const external = await fs.mkdtemp(join(tmpdir(), "snapshot-parent-"));
    outside = external;
    const parent = join(state.paths.root, "a-inputs");
    const moved = join(kind === "internal" ? state.paths.root : external, "moved-inputs");
    const read = state.files.readSymbolicLink.bind(state.files);
    let swapped = false;
    vi.spyOn(state.files, "readSymbolicLink").mockImplementation(async (path) => {
      // Include foundation files when locating the first entry of the second batch.
      if (path === replacementEntry && !swapped) {
        swapped = true;
        renameSync(parent, moved);
        symlinkSync(kind === "dangling" ? join(external, "missing") : moved, parent);
      }
      return read(path);
    });
    const snapshot = await productSourceSnapshot(state, brief);
    expect(swapped).toBe(true);
    const strict = await sequentialSnapshotSourceFiles(
      state,
      Object.keys(before.value),
      ["**"],
      { entries: new Map(), dirty: new Set() },
      "sha1",
    );
    expect(strict).toMatchObject({
      ok: false,
      error: { message: `Refusing project path with symlink component: ${parent}` },
    });
    expect(snapshot).toEqual(strict);
  },
);

it("verification reports source changed by a real check within one coarse timestamp tick", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const command = [
    process.execPath,
    "-e",
    "const fs=require('fs');const s=fs.statSync('src/value.mjs');fs.writeFileSync('src/value.mjs','export const value = 2;\\n');fs.utimesSync('src/value.mjs',s.atime,s.mtime)",
  ];
  const updated = await updateProductBrief(state, {
    brief: { ...setup.brief, checks: setup.brief.checks.map((check) => ({ ...check, command })) },
    reason: "Register a check that mutates source to test evidence freshness",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const work = await runProductWork(state, { feature: setup.brief.feature, task: "T001" });
  if (!work.ok) throw new Error(work.error.message);
  const path = join(state.paths.root, "src/value.mjs");
  await fs.writeFile(path, "export const value = 1;\n");
  await fs.utimes(path, new Date(1700000000000), new Date(1700000000000));
  const nativeStat = await fs.lstat(path, { bigint: true });
  // Hold this input in one modeled filesystem tick without depending on test scheduling.
  const lstat = (await vi.importActual<typeof fs>("node:fs/promises")).lstat;
  vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const stats = await lstat(...args);
    if (args[0] === path && args[1]?.bigint) {
      const coarse = stats as typeof nativeStat;
      coarse.mtimeNs = (nativeStat.mtimeNs / 1000000000n) * 1000000000n;
      coarse.ctimeNs = (nativeStat.ctimeNs / 1000000000n) * 1000000000n;
    }
    return stats;
  });
  const before = await productSourceSnapshot(state, updated.value);
  const verified = await runProductVerify(state, { feature: setup.brief.feature, task: "T001" });
  expect(await fs.readFile(path, "utf8")).toBe("export const value = 2;\n");
  expect(await sequentialProductSourceSnapshot(state, updated.value)).not.toEqual(before);
  expect(verified).toMatchObject({ ok: true, value: { passed: false } });
  if (!verified.ok) throw new Error(verified.error.message);
  expect(verified.value.gaps).toEqual(
    expect.arrayContaining([
      expect.stringContaining(
        'Product changed while checks ran; these executions describe the previous version. Changed input paths: "src/value.mjs".',
      ),
    ]),
  );
});
