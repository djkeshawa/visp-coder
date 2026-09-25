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
  it("routes directly to fixing the concrete failure and delivers it with relevant code", () => {
    expect(project.run("verify").exitCode).not.toBe(0);
    expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("fix");
    const context = project.json<{ feedback: { check: string; status: string; output: string }[] }>(
      "work",
    );
    expect(context.envelope.data?.feedback[0]).toMatchObject({ check: "C001", status: "failed" });
    expect(context.envelope.data?.feedback[0]?.output).toContain("AssertionError");
  });
  it("does not mistake bookkeeping changes for progress on the same failure", async () => {
    project.run("verify");
    await project.write(".visp/notes.md", "Reviewed the current attempt");
    const repeated = project.json<{ recommendation?: string }>("verify");
    expect(repeated.envelope.data?.recommendation).toContain("different hypothesis");
  });
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
