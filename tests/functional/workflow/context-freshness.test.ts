import { afterEach, beforeEach, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ProductBrief, ProductState } from "../../../src/workflow/product/model.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject());
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());

it("refuses unchecked brief edits before executing or closing work", async () => {
  const brief = project.json<ProductBrief>("brief").envelope.data;
  if (!brief) throw new Error("Missing brief");
  await project.write(
    `.visp/features/${feature}/brief.yaml`,
    stringify({
      ...brief,
      slices: brief.slices.map((slice) => ({ ...slice, approach: "A changed method" })),
    }),
  );
  await project.write("src/value.mjs", "export const value = 2;");
  const done = project.json("done", "--task", "T001");
  expect(done.result.exitCode).not.toBe(0);
  expect(done.envelope.error?.code).toBe("ARTIFACT_INVALID");
  const state: ProductState = JSON.parse(
    await project.read(`.visp/features/${feature}/product-state.json`),
  );
  expect(state.executions).toEqual([]);
  expect(state.slices.T001?.status).toBe("in-progress");
  succeeded(
    project,
    "brief",
    "--from",
    `.visp/features/${feature}/brief.yaml`,
    "--reason",
    "Use the corrected method",
  );
  expect(project.run("done").exitCode).not.toBe(0);
  succeeded(project, "work");
  succeeded(project, "done");
});
