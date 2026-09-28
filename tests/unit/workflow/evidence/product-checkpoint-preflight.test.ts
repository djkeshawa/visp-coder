import { afterEach, expect, it, vi } from "vitest";
import { ensureProductCheckpoint } from "../../../../src/workflow/product/checkpoint.js";
import * as handoffs from "../../../../src/workflow/product/reviewer-handoff.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => {
  vi.restoreAllMocks();
  await setup?.workspace.destroy();
});
it("does not build a reviewer handoff before any execution has passed", async () => {
  setup = await productWorkspace();
  const handoff = vi.spyOn(handoffs, "runProductReviewerHandoff");
  expect(
    await ensureProductCheckpoint(await setup.workspace.state(), { task: "T001" }),
  ).toMatchObject({ ok: true, value: undefined });
  expect(handoff).not.toHaveBeenCalled();
});
