import { afterEach, expect, it } from "vitest";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import {
  checkProductScope,
  readProductAuthorization,
} from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => setup?.workspace.destroy());

async function prepare() {
  setup = await productWorkspace();
  const state = await setup.workspace.state();
  const base = setup.workspace.git("rev-parse", "HEAD").trim();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const record = await readProductRecord(state);
  if (!record.ok) throw new Error(record.error.message);
  // A merge/rebase can bring committed content into the authorized worktree.
  await setup.workspace.write("README.md", "Upstream documentation\n");
  await setup.workspace.write("src/other.mjs", "export const other = 1;\n");
  setup.workspace.git("add", "README.md", "src/other.mjs");
  setup.workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "upstream change");
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const slice = setup.brief.slices[0];
  if (!slice) throw new Error("slice");
  return { state, record: record.value, slice, base };
}

it("preserves the authorization commit across work and reports committed paths separately", async () => {
  const { state, record, base } = await prepare();
  expect(await readProductAuthorization(state, record)).toMatchObject({
    ok: true,
    value: { headCommit: base },
  });
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  expect(await readProductAuthorization(state, record)).toMatchObject({
    ok: true,
    value: { headCommit: base },
  });
  expect(await runProductVerify(state, { task: "T001" })).toMatchObject({
    ok: true,
    value: { passed: true, committedChanges: ["README.md", "src/other.mjs"] },
  });
});

it("still blocks local edits on top of committed changes", async () => {
  const { state, record, slice } = await prepare();
  await setup.workspace.write("README.md", "Local edit over upstream\n");
  expect(await checkProductScope(state, record, slice)).toMatchObject({
    ok: false,
    error: { details: { outside: ["README.md"], committedChanges: ["src/other.mjs"] } },
  });
});

it("excludes committed paths from the changed-file limit", async () => {
  const { state, record, slice } = await prepare();
  const limited = { ...state, policy: { ...state.policy, maxChangedFiles: 1 } };
  expect(await checkProductScope(limited, record, slice)).toMatchObject({ ok: true });
});

it.each(["--assume-unchanged", "--skip-worktree"])(
  "does not exempt a committed path with a local edit hidden by %s",
  async (flag) => {
    const { state, record, slice } = await prepare();
    setup.workspace.git("update-index", flag, "README.md");
    await setup.workspace.write("README.md", "Hidden local edit over upstream\n");
    expect(await checkProductScope(state, record, slice)).toMatchObject({
      ok: false,
      error: { details: { outside: ["README.md"] } },
    });
  },
);

it.each(["--assume-unchanged", "--skip-worktree"])(
  "still exempts unchanged incoming content marked %s",
  async (flag) => {
    const { state, record, slice } = await prepare();
    setup.workspace.git("update-index", flag, "README.md");
    expect(await checkProductScope(state, record, slice)).toMatchObject({
      ok: true,
      value: { committedChanges: ["README.md", "src/other.mjs"] },
    });
  },
);
