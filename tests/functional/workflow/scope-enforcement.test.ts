import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductBrief } from "../../../src/workflow/product/model.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject, feature: string;
beforeEach(async () => {
  ({ project, feature } = await productProject({ forbidden: ["src/secrets.mjs"] }));
  succeeded(project, "work");
});
afterEach(async () => project?.destroy());

describe("product scope enforcement", () => {
  it("rejects writes outside the selected scope", async () => {
    await project.write("other/invoice.ts", "export const invoice = 1;");
    expect(project.run("guard").exitCode).not.toBe(0);
    expect(project.run("guard").stdout).toContain("other/invoice.ts");
  });
  it("keeps global blocked paths and forbidden files stronger than allowed globs", async () => {
    await project.write(".env", "EXAMPLE=value");
    await project.write("src/secrets.mjs", "export const key = 'fixture';");
    const guard = project.json<{ violations: { reason: string }[] }>("guard");
    expect(guard.result.exitCode).not.toBe(0);
    expect(guard.envelope.data?.violations.map((entry) => entry.reason)).toContain(
      "forbidden-file",
    );
    expect(guard.result.stdout).toContain(".env");
  });
  it("does not let a policy entry disable the global boundary", async () => {
    await project.write(".env", "EXAMPLE=value");
    await project.write(
      ".visp/policy.json",
      JSON.stringify({
        kind: "policy",
        createdAt: "2026-01-01T00:00:00Z",
        strictness: "relaxed",
        rules: { "scope.forbidden-paths": false },
      }),
    );
    expect(project.run("guard").exitCode).not.toBe(0);
  });
  it("closes edit authorization but still allows verified work to be committed", async () => {
    await project.write("src/value.mjs", "export const value = 2;");
    succeeded(project, "done");
    expect(project.run("guard").exitCode).not.toBe(0);
    expect(project.run("guard", "--include-done").exitCode).toBe(0);
    project.commit("verified implementation");
    expect(
      project.json<{ allowed: boolean }>("guard", "--path", "src/value.mjs").envelope.data?.allowed,
    ).toBe(false);
  });
  it("distinguishes unavailable command execution from failed product assertions", async () => {
    await project.authorBrief(
      feature,
      {
        checks: [
          { id: "C001", command: ["definitely-not-a-real-binary", "--check"], outcomes: ["O001"] },
        ],
      },
      "Use the explicitly unavailable fixture tool",
    );
    succeeded(project, "work");
    const verified = project.json<{ passed: boolean; executions: { status: string }[] }>("verify");
    expect(verified.result.exitCode).not.toBe(0);
    expect(verified.envelope.data?.executions[0]?.status).toBe("environment-failed");
  });
  it("allows a subsequent slice to coexist with closed work without granting the old slice new edit rights", async () => {
    const brief = project.json<ProductBrief>("brief").envelope.data;
    if (!brief) throw new Error("Missing brief");
    await project.authorBrief(
      feature,
      {
        slices: [
          ...brief.slices,
          {
            id: "T002",
            goal: "Add delivery note",
            outcomes: ["O001"],
            dependsOn: ["T001"],
            scope: { allowed: ["notes/**"] },
            checks: ["C001"],
          },
        ],
      },
      "Add a follow-up delivery slice",
    );
    succeeded(project, "work", "--task", "T001");
    await project.write("src/value.mjs", "export const value = 2;");
    succeeded(project, "done", "--task", "T001");
    succeeded(project, "work", "--task", "T002");
    await project.write("notes/delivery.md", "The public value is now two.");
    succeeded(project, "done", "--task", "T002");
    succeeded(project, "guard", "--include-done");
  });
  it("keeps unobserved behavior unassessed without requiring images for a nonvisual feature", () => {
    const review = project.json<{ assessments: unknown[]; gaps: string[] }>("review");
    expect(review.result.exitCode).toBe(0);
    expect(review.envelope.data?.assessments).toEqual([]);
    expect(review.envelope.data?.gaps).toEqual([]);
    expect(project.run("done").exitCode).not.toBe(0);
  });
  it("audits all tracked files with bounded text output", async () => {
    for (let index = 0; index < 40; index++)
      await project.write(`other/file-${index}.ts`, `export const n = ${index};`);
    project.commit("audit fixture files", { skipHooks: true });
    const guard = project.run("guard", "--all");
    expect(guard.exitCode).not.toBe(0);
    expect(
      guard.stdout.split("\n").filter((line) => line.trim().startsWith("- ")).length,
    ).toBeLessThanOrEqual(20);
    expect(guard.stdout).toContain("more (--json for all of them)");
  });
});
