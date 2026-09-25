import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProductBrief, ProductState } from "../../../src/workflow/product/model.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

describe("a complete product feature through the built CLI", () => {
  let project: TestProject, feature: string;
  beforeAll(async () => {
    ({ project, feature } = await productProject());
  });
  afterAll(async () => {
    await project?.destroy();
  });

  it("preserves the original request and uses one authored brief", async () => {
    const brief = project.json<ProductBrief>("brief").envelope.data;
    expect(brief?.originalRequest).toBe("Return two");
    expect(brief?.outcomes[0]?.statement).toBe("The public value is two");
    for (const file of ["research.json", "spec.json", "plan.json", "tasks.json"])
      await expect(project.read(`.visp/features/${feature}/${file}`)).rejects.toThrow();
  });
  it("delivers relevant decisions and source while authorizing the usable slice", async () => {
    await project.authorBrief(
      feature,
      {
        decisions: [
          {
            id: "D001",
            statement: "Change the existing public export",
            evidence: ["src/value.mjs"],
            implications: ["Preserve the named export"],
            outcomes: ["O001"],
          },
        ],
      },
      "Use the existing module boundary",
    );
    const context = project.json<{
      mayEdit: boolean;
      decisions: unknown[];
      files: { path: string }[];
    }>("work", "--task", "T001");
    expect(context.result.exitCode, context.result.stdout).toBe(0);
    expect(context.envelope.data?.mayEdit).toBe(true);
    expect(context.envelope.data?.decisions).toMatchObject([
      { implications: ["Preserve the named export"] },
    ]);
    expect(context.envelope.data?.files.map((file) => file.path)).toContain("src/value.mjs");
  });
  it("keeps a real behavioral failure open and returns concrete feedback", () => {
    const verified = project.json<{
      passed: boolean;
      executions: { status: string; output: string }[];
    }>("verify", "--task", "T001");
    expect(verified.result.exitCode).not.toBe(0);
    expect(verified.envelope.data?.passed).toBe(false);
    expect(JSON.stringify(verified.envelope.data)).toContain("failed");
    expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("fix");
  });
  it("fixes the implementation, closes the slice, and accepts the assembled product", async () => {
    const guard = project.json<{ allowed: boolean }>("guard", "--path", "src/value.mjs");
    expect(guard.envelope.data?.allowed).toBe(true);
    await project.write("src/value.mjs", "export const value = 2;\n");
    const done = project.json<{ closed: boolean }>("done", "--task", "T001");
    expect(done.result.exitCode, done.result.stdout).toBe(0);
    expect(done.envelope.data?.closed).toBe(true);
    const review = project.json<ProductReviewBundle>("review").envelope.data;
    if (!review) throw new Error("Missing review bundle");
    await project.write(
      ".visp/drafts/review.json",
      JSON.stringify({
        subjectDigest: review?.subjectDigest,
        feedback: moduleFeedback(review),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary:
              "The executed public-module assertion confirms value two and matches the preserved request",
            evidence: ["C001"],
          },
        ],
      }),
    );
    succeeded(project, "review", "--from", ".visp/drafts/review.json");
    succeeded(project, "accept");
    const state: ProductState = JSON.parse(
      await project.read(`.visp/features/${feature}/product-state.json`),
    );
    expect(state.status).toBe("accepted");
    expect(state.executions.some((entry) => entry.status === "failed")).toBe(true);
    expect(state.executions.at(-1)?.status).toBe("passed");
  });
  it("generates a reviewer handoff from execution records and preserves commit enforcement", () => {
    expect(succeeded(project, "pr")).toContain("The public value is two");
    project.commit("return the promised value");
    expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("complete");
    succeeded(project, "index", "--refresh");
    expect(project.run("doctor").exitCode).toBe(0);
  });
});
