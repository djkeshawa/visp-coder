import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject());
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());
async function widen() {
  const brief = project.json<ProductBrief>("brief").envelope.data;
  if (!brief) throw new Error("Missing brief");
  await project.authorBrief(
    feature,
    {
      slices: brief.slices.map((slice) => ({
        ...slice,
        scope: { ...slice.scope, allowed: [...slice.scope.allowed, "package.json"] },
      })),
    },
    "The implementation needs a package metadata change",
  );
}
describe("method revision and authorization", () => {
  it("refuses a file before scope admits it", async () => {
    await project.write("package.json", '{"name":"fixture","version":"2"}');
    expect(project.run("guard").exitCode).not.toBe(0);
  });
  it("reauthorizes widened scope even when the working tree already contains the proposed change", async () => {
    await project.write("package.json", '{"name":"fixture","version":"2"}');
    await widen();
    expect(project.run("guard").exitCode).not.toBe(0);
    succeeded(project, "work");
    succeeded(project, "guard");
  });
  it("continues refusing files no slice owns", async () => {
    await widen();
    succeeded(project, "work");
    await project.write("other/file.ts", "export const x = 1;");
    expect(project.run("guard").exitCode).not.toBe(0);
  });
  it("permits a reasoned check-method correction while protecting the original outcome", async () => {
    const before = project.json<ProductBrief>("brief").envelope.data;
    if (!before) throw new Error("Missing brief");
    await project.authorBrief(
      feature,
      {
        checks: before.checks.map((check) => ({
          ...check,
          command: [process.execPath, "--test", "--test-reporter=tap", "tests/value.test.mjs"],
        })),
      },
      "Use structured Node test reporting",
    );
    succeeded(project, "work");
    const after = project.json<ProductBrief>("brief").envelope.data;
    expect(after?.outcomes).toEqual(before.outcomes);
    await project.write(".visp/weakened.json", JSON.stringify({ ...after, outcomes: [] }));
    const refused = project.run(
      "brief",
      "--from",
      ".visp/weakened.json",
      "--reason",
      "Drop the promised outcome",
    );
    expect(refused.exitCode).not.toBe(0);
  });
});
