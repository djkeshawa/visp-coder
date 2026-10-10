import { afterEach, beforeEach, expect, it } from "vitest";
import { environmentNext } from "../../../../src/workflow/product/environment.js";
import {
  runProductNext,
  runProductVerify,
  runProductWork,
} from "../../../../src/workflow/product/index.js";
import { readProductRecord, saveProductState } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
beforeEach(async () => {
  setup = await productWorkspace();
});
afterEach(async () => {
  await setup.workspace.destroy();
});

/** The slice's own check ended environment-failed with the given output, on the current source. */
async function failedWith(output: string) {
  expect((await runProductWork(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  await setup.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect((await runProductVerify(await setup.workspace.state(), { task: "T001" })).ok).toBe(true);
  const record = await readProductRecord(await setup.workspace.state(), { task: "T001" });
  if (!record.ok) throw new Error(record.error.message);
  const last = record.value.state.executions.findLast((entry) => entry.check === "C001");
  if (!last) throw new Error("no execution");
  const saved = await saveProductState(await setup.workspace.state(), record.value, {
    ...record.value.state,
    executions: [{ ...last, id: "env-failed", status: "environment-failed", output }],
  });
  expect(saved.ok).toBe(true);
  const next = await runProductNext(await setup.workspace.state(), { task: "T001" });
  if (!next.ok) throw new Error(next.error.message);
  return next.value;
}

it.each([
  "app-unreachable: Start or restart the app at http://localhost/",
  'missing-command: "ruff" is not installed in this environment.',
])("uses the environment's own recovery for an open slice whose check says %s", async (output) => {
  const next = await failedWith(output);
  const expected = environmentNext(setup.brief.feature, "T001", [output], "verify");
  expect(next.objective).toBe(expected.objective);
  expect(next.objective).not.toContain("Continue the authorized slice");
  expect(next.completion).toBe("unresolved-environment");
});

it("keeps the general environment step for other output", async () => {
  const next = await failedWith("the check could not start");
  expect(next.objective).toContain("Continue the authorized slice");
});
