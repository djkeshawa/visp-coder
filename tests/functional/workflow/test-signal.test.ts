import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject;
beforeEach(async () => {
  ({ project } = await productProject());
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());
describe("behavior checks over superficial test churn", () => {
  it("accepts an unchanged existing test that independently detects the implementation repair", async () => {
    expect(project.run("verify").exitCode).not.toBe(0);
    await project.write("src/value.mjs", "export const value = 2;");
    const done = project.json<{ closed: boolean }>("done");
    expect(done.result.exitCode, done.result.stdout).toBe(0);
    expect(done.envelope.data?.closed).toBe(true);
    expect(project.git("diff", "--", "tests/value.test.mjs")).toBe("");
  });
  it("does not accept a wrong implementation just because its test file changed", async () => {
    await project.write("src/value.mjs", "export const value = 3;");
    await project.write(
      "tests/value.test.mjs",
      `${await project.read("tests/value.test.mjs")}\n// Additional explanation\n`,
    );
    expect(project.run("done").exitCode).not.toBe(0);
  });
});
