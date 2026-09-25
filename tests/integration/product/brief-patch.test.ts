import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../src/workflow/product/brief.js";
import { sliceDigest } from "../../../src/workflow/product/model.js";
import { readProductBrief } from "../../../src/workflow/product/store.js";
import { runProductContext, runProductWork } from "../../../src/workflow/product/work.js";
import { productWorkspace } from "../../unit/support/product-workspace.js";
import type { TestWorkspace } from "../../unit/support/workspace.js";

const workspaces: TestWorkspace[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.destroy()));
});

it("changes one check and scope without reconstructing protected intent or generated IDs", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  expect((await runProductWork(state)).ok).toBe(true);
  const result = await updateProductBrief(state, {
    patch: {
      checks: [{ id: "C001", files: ["src/value.mjs", "test/value.test.mjs", "test/extra.mjs"] }],
      slices: [{ id: "T001", scope: { allowed: ["src/value.mjs", "test/*.mjs"] } }],
    },
    reason: "Include the integration regression",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.value.originalRequest).toBe(brief.originalRequest);
  expect(result.value.acceptanceBaseline).toEqual(brief.acceptanceBaseline);
  expect(result.value.outcomes).toEqual(brief.outcomes);
  expect(result.value.checks[0]?.command).toEqual(brief.checks[0]?.command);
  expect(result.value.slices[0]?.scope.expected).toEqual(brief.slices[0]?.scope.expected);
  expect(result.value.slices[0]?.scope.allowed).toContain("test/*.mjs");
  expect(result.value.slices[0]?.checks).toEqual(["C001"]);
});

it("appends entries and allocates IDs without replacing existing entries", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const result = await updateProductBrief(await workspace.state(), {
    patch: { checks: [{ command: ["node", "--check", "src/value.mjs"] }] },
    reason: "Add a syntax check alongside behavior",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.value.checks[0]).toEqual(brief.checks[0]);
  expect(result.value.checks[1]?.id).toBe("C002");
});

it("rejects protected intent changes and invalid merged references without writing state", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const state = await workspace.state();
  // A reworded request in a patch is ignored, never applied.
  const reworded = await updateProductBrief(state, {
    patch: { originalRequest: "A different request" },
    reason: "Reworded",
  });
  expect(reworded.ok && reworded.value.originalRequest).toBe(brief.originalRequest);
  for (const patch of [
    { acceptanceBaseline: [] },
    { outcomes: [{ id: "O001", statement: "Return anything" }] },
    { slices: [{ id: "T001", checks: ["missing"] }] },
    {
      checks: [
        { id: "C001", files: [] },
        { id: "C001", files: [] },
      ],
    },
    // A list of step strings is normalized into one action; structured steps are not.
    { examples: [{ title: "Wrong shape", when: [{ step: "click" }] }] },
  ]) {
    const result = await updateProductBrief(state, { patch, reason: "Invalid update" });
    expect(result.ok, JSON.stringify(patch)).toBe(false);
    expect(await readProductBrief(state)).toEqual({ ok: true, value: brief });
  }
});

it("persists an explicit task class and changes only the selected slice contract", async () => {
  const { workspace, brief } = await productWorkspace();
  workspaces.push(workspace);
  const original = brief.slices[0];
  if (!original) throw new Error("Missing slice");
  expect(original).not.toHaveProperty("taskClass");
  expect((await runProductWork(await workspace.state())).ok).toBe(true);
  const result = await updateProductBrief(await workspace.state(), {
    patch: { slices: [{ id: original.id, taskClass: "bugfix" }] },
    reason: "This slice repairs the observed behavior",
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  const selected = result.value.slices[0];
  if (!selected) throw new Error("Missing updated slice");
  expect(selected).toEqual({ ...original, taskClass: "bugfix" });
  const context = await runProductContext(await workspace.state());
  expect(context).toMatchObject({ ok: true, value: { mayEdit: false, taskClass: "bugfix" } });
  expect(sliceDigest(result.value, selected)).not.toBe(sliceDigest(brief, original));
  expect(await readProductBrief(await workspace.state())).toEqual({
    ok: true,
    value: result.value,
  });
  const invalid = await updateProductBrief(await workspace.state(), {
    patch: { slices: [{ id: original.id, taskClass: "guessed" }] },
    reason: "Invalid classification",
  });
  expect(invalid.ok).toBe(false);
  expect(await readProductBrief(await workspace.state())).toEqual({
    ok: true,
    value: result.value,
  });
});
