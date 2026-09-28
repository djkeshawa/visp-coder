import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => project?.workspace.destroy());

it("uses source and tests instead of installed guides for broad-scope excerpts", async () => {
  project = await productWorkspace();
  const workspace = project.workspace;
  const revised = await updateProductBrief(await workspace.state(), {
    reason: "Use the light-path scope",
    patch: { slices: [{ id: "T001", scope: { allowed: ["**"] } }] },
  });
  expect(revised.ok).toBe(true);
  const worked = await runProductWork(await workspace.state(), { task: "T001" });
  expect(worked.ok, worked.ok ? "" : worked.error.message).toBe(true);
  if (!worked.ok) return;
  expect(worked.value.files.map((file) => file.path)).toContain("src/value.mjs");
  expect(worked.value.files.map((file) => file.path)).toContain("test/value.test.mjs");
  expect(worked.value.files.map((file) => file.path)).not.toContain("VISP.commands.md");
  expect(worked.value.files.map((file) => file.path)).not.toContain(".gitignore");
});
