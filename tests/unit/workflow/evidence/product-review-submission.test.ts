import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import {
  runProductDone,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review/review.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

let workspace: TestWorkspace;
let bundle: ProductReviewBundle;
let unavailable: string;

/** A closed slice whose review lists a binary file in scope as unavailable source. */
beforeEach(async () => {
  const project = await productWorkspace();
  workspace = project.workspace;
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...project.brief,
        outcomes: project.brief.outcomes.map((outcome) => ({
          ...outcome,
          expectations: [
            { id: "E001", statement: "The value is the number two", provenance: "agent-proposed" },
          ],
        })),
        slices: project.brief.slices.map((slice) => ({
          ...slice,
          scope: { ...slice.scope, allowed: [...slice.scope.allowed, "src/logo.png"] },
        })),
      },
      intentChange: {
        reason: "The slice also ships a logo and states its expectation",
        provenance: "test fixture",
      },
    }),
  );
  value(await runProductWork(await workspace.state()));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  await workspace.write("src/logo.png", Buffer.from([0x89, 0x50, 0xff, 0xfe, 0x00, 0x01]));
  value(await runProductDone(await workspace.state()));
  bundle = value(await runProductReview(await workspace.state(), {}));
  const entry = bundle.evidence.find(
    (candidate) => candidate.kind === "source" && candidate.status === "unavailable",
  );
  if (!entry) throw new Error("Expected the binary file as unavailable source");
  unavailable = entry.id;
});
afterEach(async () => {
  await workspace.destroy();
});

async function submit(assessments: unknown) {
  return runProductReview(await workspace.state(), {
    subjectDigest: bundle.subjectDigest,
    feedback: moduleFeedback(bundle),
    assessments,
  });
}

describe("submitted assessments that cite evidence VISP could not deliver", () => {
  it("keep their verdict, drop the citation and say so", async () => {
    const reviewed = value(
      await submit([
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The check returned two",
          evidence: ["C001", unavailable],
          expectations: [
            {
              id: "E001",
              status: "satisfied",
              reason: "The check asserts the number",
              evidence: ["C001", unavailable],
            },
          ],
        },
      ]),
    );
    const [assessment] = reviewed.assessments;
    expect(assessment?.status).toBe("satisfied");
    expect(assessment?.evidence).not.toContain(unavailable);
    expect(assessment?.expectations[0]?.evidence).not.toContain(unavailable);
    expect(assessment?.summary).toContain(
      `VISP dropped citations of evidence it could not deliver: ${unavailable}`,
    );
  });

  it("keep them when the judgment is unclear, since that may be its reason", async () => {
    const reviewed = value(
      await submit([
        {
          outcome: "O001",
          status: "unclear",
          summary: "The logo could not be inspected",
          evidence: ["C001", unavailable],
          expectations: [{ id: "E001", status: "unclear", reason: "Not judged" }],
        },
      ]),
    );
    const [assessment] = reviewed.assessments;
    expect(assessment?.status).toBe("unclear");
    expect(assessment?.evidence).toContain(unavailable);
    expect(assessment?.summary).not.toContain("VISP dropped citations");
  });

  it("leave malformed assessments to schema validation", async () => {
    for (const assessments of ["satisfied", [{ outcome: "O001" }]])
      expect(await submit(assessments)).toMatchObject({
        ok: false,
        error: {
          code: "ARTIFACT_INVALID",
          message: expect.stringContaining("Invalid assessments"),
        },
      });
  });
});
