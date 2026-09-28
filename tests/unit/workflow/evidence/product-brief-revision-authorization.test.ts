import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { checkProductScope } from "../../../../src/workflow/product/scopes.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => project?.workspace.destroy());

it("preserves the original scope baseline when a check revision revokes authorization", async () => {
  project = await productWorkspace();
  const workspace = project.workspace;
  expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
  await workspace.write("outside.mjs", "export const outside = true;\n");
  const updated = await updateProductBrief(await workspace.state(), {
    reason: "Refine the check",
    patch: {
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--test", "test/value.test.mjs", "--test-reporter=tap"],
        },
      ],
    },
  });
  expect(updated.ok && updated.value).toMatchObject({ authorizationRevoked: true, mayEdit: false });
  expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
  const record = await readProductRecord(await workspace.state());
  expect(record.ok).toBe(true);
  if (!record.ok) return;
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const scope = await checkProductScope(
    await workspace.state(),
    record.value,
    slice,
  );
  expect(scope).toMatchObject({ ok: false, error: { code: "SCOPE_VIOLATION" } });
});

it("does not reopen a slice for an unlinked advisory decision", async () => {
  project = await productWorkspace();
  const workspace = project.workspace;
  const before = await readProductRecord(await workspace.state());
  if (!before.ok) throw new Error(before.error.message);
  const digest = before.value.state.slices.T001?.contractDigest;
  const updated = await updateProductBrief(await workspace.state(), {
    reason: "Explain the implementation method",
    patch: { decisions: [{ statement: "Keep functions pure", rationale: "Simplify reasoning" }] },
  });
  expect(updated.ok).toBe(true);
  const after = await readProductRecord(await workspace.state());
  expect(after.ok && after.value.state.slices.T001?.contractDigest).toBe(digest);
});
