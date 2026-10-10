import { afterEach, expect, it } from "vitest";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
afterEach(async () => setup?.workspace.destroy());
it("names an undeclared untracked file before it can silently invalidate evidence", async () => {
  setup = await productWorkspace();
  await setup.workspace.write("notes.txt", "my notes\n");
  const state = await setup.workspace.state();
  const work = await runProductWork(state, { task: "T001" });
  expect(work.ok).toBe(true);
  if (work.ok)
    expect(work.value.notes.join(" ")).toMatch(/notes\.txt.*outside.*scope.*check.*ignore/i);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  const verified = await runProductVerify(state, { task: "T001" });
  expect(verified.ok).toBe(true);
  if (verified.ok)
    expect(JSON.stringify(verified.value)).toMatch(/notes\.txt.*outside.*scope.*check.*ignore/i);
});
