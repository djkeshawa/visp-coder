import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareCandidate } from "../../../../src/workflow/product/candidate.js";
import { criticSelection } from "../../../../src/workflow/product/critic-store.js";
import { productSourceSnapshot } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
});

it("snapshots more than 20000 tracked files and preserves a bounded candidate", async () => {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const selected = await criticSelection(state, { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  await mkdir(join(state.paths.root, "vendor"));
  for (let offset = 0; offset < 20010; offset += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, 20010 - offset) }, (_, i) =>
        writeFile(join(state.paths.root, `vendor/file-${offset + i}.txt`), "dependency\n"),
      ),
    );
  }
  setup.workspace.git("add", "vendor");
  setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "large dependency tree");
  const reads = vi.spyOn(state.files, "readBytesIfExists");
  expect(await productSourceSnapshot(state, setup.brief)).toMatchObject({ ok: true });
  expect(reads.mock.calls.length).toBeLessThan(100);
  const candidate = await prepareCandidate(state, selected.value, {});
  expect(candidate.ok).toBe(true);
  if (candidate.ok) expect(candidate.value.candidate.files.length).toBeLessThan(100);
}, 60000);

it("detects changes outside declared inputs and stays stable when those bytes are committed", async () => {
  setup = await productWorkspace();
  await setup.workspace.write("outside.txt", "original");
  setup.workspace.git("add", "outside.txt");
  setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "other product input");
  const state = await setup.workspace.state();
  const before = await productSourceSnapshot(state, setup.brief);
  await setup.workspace.write("outside.txt", "changed");
  const changed = await productSourceSnapshot(state, setup.brief);
  expect(changed).not.toEqual(before);
  setup.workspace.git("add", "outside.txt");
  setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "same working bytes");
  expect(await productSourceSnapshot(state, setup.brief)).toEqual(changed);
});

it.each(["--assume-unchanged", "--skip-worktree"])(
  "does not let Git %s hide changed product content",
  async (flag) => {
    setup = await productWorkspace();
    await setup.workspace.write("outside.txt", "original");
    setup.workspace.git("add", "outside.txt");
    setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "other input");
    const state = await setup.workspace.state();
    const before = await productSourceSnapshot(state, setup.brief);
    setup.workspace.git("update-index", flag, "outside.txt");
    await setup.workspace.write("outside.txt", "changed but hidden by Git status");
    expect(await productSourceSnapshot(state, setup.brief)).not.toEqual(before);
  },
);
