import { lstat, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyFileTransaction } from "../../../../src/core/file-transaction.js";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { prepareCandidate, restoreCandidate } from "../../../../src/workflow/product/candidate.js";
import { criticSelection } from "../../../../src/workflow/product/critic-store.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { productSourceDigest } from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
let external: string | undefined;
afterEach(async () => {
  await setup?.workspace.destroy();
  if (external) await rm(external, { recursive: true, force: true });
  external = undefined;
});

it.each([
  "value.mjs",
  "../test",
  "../dist/missing.mjs",
  "../../outside-library",
  "../large-target.bin",
  "external-file",
])(
  "snapshots and restores a symlink to %s as a link without following its target",
  async (target) => {
    setup = await productWorkspace();
    if (target === "external-file") {
      external = await mkdtemp(join(tmpdir(), "visp-link-target-"));
      target = join(external, "source");
      await writeFile(target, "external source bytes");
    }
    const updated = await updateProductBrief(await setup.workspace.state(), {
      brief: {
        ...setup.brief,
        slices: setup.brief.slices.map((slice) => ({
          ...slice,
          scope: { ...slice.scope, allowed: [...slice.scope.allowed, "src/link"] },
        })),
      },
      reason: "Include the repository link in this slice",
    });
    expect(updated.ok).toBe(true);
    if (target === "../large-target.bin")
      await setup.workspace.write("large-target.bin", Buffer.alloc(32 * 1024 * 1024 + 1));
    const path = join(setup.workspace.root, "src/link");
    await symlink(target, path);
    setup.workspace.git("add", "src/link");
    setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "repository symlink");
    const state = await setup.workspace.state();
    expect(await runProductWork(state, { task: "T001" })).toMatchObject({ ok: true });
    expect(await runProductNext(state)).toMatchObject({ ok: true });
    const selected = await criticSelection(state, { task: "T001" });
    if (!selected.ok) throw new Error(selected.error.message);
    const prepared = await prepareCandidate(state, selected.value, {});
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect(prepared.value.candidate.identityOnly).toBeUndefined();
    expect(prepared.value.candidate.files.find((file) => file.path === "src/link")).toMatchObject({
      symlink: true,
      content: Buffer.from(target).toString("base64"),
    });
    expect(
      await applyFileTransaction(state.paths.root, "preserve-link", prepared.value.mutations),
    ).toMatchObject({ ok: true });
    await rm(path);
    await symlink("../new-target", path);
    const changed = await productSourceDigest(state);
    if (!changed.ok) throw new Error(changed.error.message);
    expect(changed.value).not.toBe(prepared.value.candidate.subject);
    expect(
      await restoreCandidate(state, selected.value, prepared.value.candidate.id, changed.value),
    ).toMatchObject({ ok: true });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readlink(path)).toBe(target);
    expect(await readFile(join(state.paths.root, "src/value.mjs"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  },
);
