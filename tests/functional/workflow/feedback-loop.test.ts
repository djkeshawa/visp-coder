import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductState } from "../../../src/workflow/product/model.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject());
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());
describe("product feedback after a failed check", () => {
  it("retains execution history and clears current failure feedback after a real repair", async () => {
    project.run("verify");
    await project.write("src/value.mjs", "export const value = 2;");
    succeeded(project, "verify");
    expect(project.json<{ feedback: unknown[] }>("work").envelope.data?.feedback).toEqual([]);
    const state: ProductState = JSON.parse(
      await project.read(`.visp/features/${feature}/product-state.json`),
    );
    expect(
      state.executions.filter((entry) => entry.check === "C001").map((entry) => entry.status),
    ).toEqual(["failed", "passed"]);
  });
});
