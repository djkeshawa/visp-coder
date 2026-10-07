import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { snapshotSourceFiles } from "../../../../src/workflow/product/source-snapshot.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";
import {
  sequentialProductSourceSnapshot,
  sequentialSnapshotSourceFiles,
} from "../../support/sequential-product-snapshot.js";

it.each(["files", "product"])(
  "%s snapshot refuses a parent replaced and restored during one entry read",
  async (kind) => {
    const setup = await productWorkspace();
    const state = await setup.workspace.state();
    const outside = await mkdtemp(join(tmpdir(), "visp-transient-parent-"));
    const parent = join(state.paths.root, "a-inputs");
    const savedParent = join(state.paths.root, "original-inputs");
    const paths = Array.from(
      { length: 25 },
      (_, index) => `a-inputs/f${String(index).padStart(2, "0")}`,
    );
    const brief = {
      ...setup.brief,
      slices: setup.brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: ["**"] },
      })),
    };
    const objects = { entries: new Map(), dirty: new Set<string>() };
    const original = state.files.readSymbolicLink.bind(state.files);
    try {
      for (const path of paths) await setup.workspace.write(path, "original");
      await symlink("foreign-target", join(outside, "f24"));
      const before = await productSourceSnapshot(state, brief);
      expect(before.ok).toBe(true);

      async function run(optimized: boolean) {
        let swapped = false;
        state.files.readSymbolicLink = async (path) => {
          if (path !== paths[24] || swapped) return original(path);
          // Entry 25 follows the first batch, which used this real parent.
          swapped = true;
          renameSync(parent, savedParent);
          symlinkSync(outside, parent);
          try {
            return await original(path);
          } finally {
            unlinkSync(parent);
            renameSync(savedParent, parent);
          }
        };
        try {
          const result =
            kind === "product"
              ? optimized
                ? await productSourceSnapshot(state, brief)
                : await sequentialProductSourceSnapshot(state, brief)
              : optimized
                ? await state.files.withReadPass(() =>
                    snapshotSourceFiles(state, paths, ["**"], objects, "sha1"),
                  )
                : await sequentialSnapshotSourceFiles(state, paths, ["**"], objects, "sha1");
          expect(swapped).toBe(true);
          return result;
        } finally {
          state.files.readSymbolicLink = original;
        }
      }

      const optimized = await run(true);
      const sequential = await run(false);
      expect(sequential).toEqual({
        ok: false,
        error: {
          code: "IO_ERROR",
          message: `Refusing project path with symlink component: ${parent}`,
        },
      });
      expect(optimized).toEqual(sequential);
      expect(await productSourceSnapshot(state, brief)).toEqual(before);
    } finally {
      state.files.readSymbolicLink = original;
      await setup.workspace.destroy();
      await rm(outside, { recursive: true, force: true });
    }
  },
);
