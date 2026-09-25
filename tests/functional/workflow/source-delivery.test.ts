import { afterEach, describe, expect, it } from "vitest";
import { productProject } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());
describe("source and delivery decisions", () => {
  it("authorizes one authored HTML file without speculative module or test layers", async () => {
    const result = await productProject({
      goal: "Deliver one HTML file",
      files: {},
      definition: {
        outcomes: [
          {
            id: "O001",
            kind: "experience",
            statement: "A usable filtering page",
            priority: "must",
          },
        ],
        decisions: [
          {
            id: "D001",
            statement: "Deliver one authored index.html with no build step",
            rationale: "Honor the requested delivery constraint",
            outcomes: ["O001"],
            implications: ["Keep the small filtering behavior cohesive"],
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "A usable filter",
            outcomes: ["O001"],
            scope: { allowed: ["index.html"] },
          },
        ],
      },
    });
    project = result.project;
    const work = project.json<{
      mayEdit: boolean;
      scope: { allowed: string[] };
      decisions: { statement: string }[];
    }>("work");
    expect(work.result.exitCode, work.result.stdout).toBe(0);
    expect(work.envelope.data?.scope.allowed).toEqual(["index.html"]);
    expect(work.envelope.data?.decisions[0]?.statement).toContain("one authored index.html");
    expect(await project.read("package.json")).not.toContain("build");
    expect(project.git("status", "--short", "src", "dist")).toBe("");
  });
  it("can revise a delivery method without re-authoring user outcomes", async () => {
    const result = await productProject();
    project = result.project;
    await project.authorBrief(result.feature, {
      decisions: [
        {
          id: "D001",
          statement: "Reuse the existing public module",
          rationale: "Avoid another source copy",
          outcomes: ["O001"],
        },
      ],
    });
    const work = project.run("work");
    expect(work.exitCode, work.stdout).toBe(0);
    expect(work.stdout).toContain("Avoid another source copy");
  });
});
