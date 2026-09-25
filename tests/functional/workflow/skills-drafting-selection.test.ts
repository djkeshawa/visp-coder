import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject } from "../support/product.js";
import type { TestProject } from "../support/project.js";

describe("retired drafting compatibility", () => {
  let project: TestProject;
  beforeEach(async () => {
    ({ project } = await productProject());
    await project.write(
      ".visp/drafts/spec-craft.md",
      "---\nname: spec-craft\nappliesTo:\n  stage:\n    - spec\n---\n\n## Procedure\n\nResearch the conventions before writing anything.\n",
    );
    expect(
      project.run(
        "skill",
        "propose",
        "--id",
        "spec-craft",
        "--file",
        ".visp/drafts/spec-craft.md",
        "--origin",
        "seeded",
      ).exitCode,
    ).toBe(0);
    expect(project.run("skill", "admit", "spec-craft", "--by", "reviewer").exitCode).toBe(0);
  });
  afterEach(async () => project.destroy());
  it.each(["research", "spec", "plan", "tasks"])(
    "%s is no longer a command and authors no documents",
    (stage) => {
      const result = project.run(stage);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("unknown command");
      expect(result.stdout).not.toContain("Research the conventions");
    },
  );
  it("keeps retired-stage advice out of current implementation context", () => {
    const result = project.json<ProductWorkContext>("work");
    expect(result.result.exitCode, result.result.stdout).toBe(0);
    expect(result.envelope.data?.skills).toEqual([]);
    expect(result.envelope.data?.notes.join("\n")).toContain("spec-craft: trigger did not match");
    expect(result.result.stdout).not.toContain("Research the conventions before writing anything.");
  });
});
