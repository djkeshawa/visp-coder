import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject());
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());

describe("observable acceptance outcomes", () => {
  it("executes a criterion's meaningful check and records its actual result", async () => {
    await project.write("src/value.mjs", "export const value = 2;");
    const verified = project.json<{ passed: boolean; executions: { provenance: string }[] }>(
      "verify",
    );
    expect(verified.result.exitCode, verified.result.stdout).toBe(0);
    expect(verified.envelope.data?.passed).toBe(true);
    expect(JSON.stringify(verified.envelope.data)).toContain("supervisor-executed");
  });
  it("fails on refuted behavior and never treats a matching test name as correctness", async () => {
    await project.write("src/value.mjs", "export const value = 1000;");
    const done = project.json<{ closed: boolean; verification: { passed: boolean } }>("done");
    expect(done.result.exitCode).not.toBe(0);
    expect(done.envelope.data?.closed).toBe(false);
    expect(project.run("accept").exitCode).not.toBe(0);
  });
  it("refuses to start a functional outcome that no check exercises", async () => {
    await project.authorBrief(
      feature,
      {
        checks: [],
        slices: [
          {
            id: "T001",
            goal: "Return the promised value",
            outcomes: ["O001"],
            scope: { allowed: ["src/**"], expected: ["src/value.mjs"] },
          },
        ],
      },
      "Remove a proposed check while keeping the user outcome",
    );
    const work = project.run("work");
    expect(work.exitCode).not.toBe(0);
    expect(work.stderr + work.stdout).toContain("T001 has no runnable check");
  });
});
