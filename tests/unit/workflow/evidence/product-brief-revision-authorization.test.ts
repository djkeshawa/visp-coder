import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { checkProductScope } from "../../../../src/workflow/product/scopes.js";
import { authorizationPath, readProductRecord } from "../../../../src/workflow/product/store.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => project?.workspace.destroy());

it("preserves the original scope baseline when a check revision revokes authorization", async () => {
  project = await productWorkspace();
  const workspace = project.workspace;
  await workspace.write(".env", "SECRET=original\n");
  const state = await workspace.state();
  expect((await runProductWork(state, { task: "T001" })).ok).toBe(true);
  const path = authorizationPath(state, project.brief.feature);
  const original = JSON.parse(await readFile(path, "utf8"));
  await workspace.write("README.md", "An incoming committed change\n");
  workspace.git("add", "README.md");
  workspace.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "upstream change");
  await workspace.write("outside.mjs", "export const outside = true;\n");
  await workspace.write(".env", "SECRET=changed\n");
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
  const revisedState = await workspace.state();
  const changedConfig = {
    ...revisedState,
    config: {
      ...revisedState.config,
      workflow: { ...revisedState.config.workflow, blockedPaths: [] },
    },
  };
  expect((await runProductWork(changedConfig, { task: "T001" })).ok).toBe(true);
  const restored = JSON.parse(await readFile(path, "utf8"));
  expect(restored.baseline).toEqual(original.baseline);
  expect(restored.blockedPaths).toEqual(original.blockedPaths);
  expect(restored.envBaseline).toEqual(original.envBaseline);
  expect(restored.headCommit).toBe(original.headCommit);
  const record = await readProductRecord(await workspace.state());
  expect(record.ok).toBe(true);
  if (!record.ok) return;
  const slice = record.value.brief.slices[0];
  if (!slice) throw new Error("Missing slice");
  const scope = await checkProductScope(await workspace.state(), record.value, slice);
  expect(scope).toMatchObject({
    ok: false,
    error: {
      code: "SCOPE_VIOLATION",
      details: { forbidden: [".env"], outside: ["outside.mjs"] },
    },
  });
});

it("does not reopen a slice for an unlinked advisory decision", async () => {
  project = await productWorkspace();
  const workspace = project.workspace;
  const before = await readProductRecord(await workspace.state());
  if (!before.ok) throw new Error(before.error.message);
  const digest = before.value.state.slices.T001?.contractDigest;
  expect((await runProductWork(await workspace.state(), { task: "T001" })).ok).toBe(true);
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  const done = await runProductDone(await workspace.state(), { task: "T001" });
  expect(done.ok && done.value.closed).toBe(true);
  const updated = await updateProductBrief(await workspace.state(), {
    reason: "Explain the implementation method",
    patch: { decisions: [{ statement: "Keep functions pure", rationale: "Simplify reasoning" }] },
  });
  expect(updated.ok).toBe(true);
  const after = await readProductRecord(await workspace.state());
  expect(after.ok && after.value.state.slices.T001?.contractDigest).toBe(digest);
  expect(after.ok && after.value.state.slices.T001?.status).toBe("closed");
  const linked = await updateProductBrief(await workspace.state(), {
    reason: "Change the linked method",
    patch: {
      decisions: [
        {
          id: "D002",
          statement: "Use a different algorithm",
          rationale: "New approach",
          outcomes: ["O001"],
        },
      ],
    },
  });
  expect(linked.ok && linked.value.resetSlices).toEqual(["T001"]);
  const reopened = await readProductRecord(await workspace.state());
  expect(reopened.ok && reopened.value.state.sliceHistory).toContainEqual(
    expect.objectContaining({ task: "T001", from: "closed", to: "pending" }),
  );
});
