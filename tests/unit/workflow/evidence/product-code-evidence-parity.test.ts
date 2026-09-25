import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { reviewInputTemplate } from "../../../../src/workflow/product-inputs.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => {
  await project?.workspace.destroy();
});
function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
it("includes declared documentation in review evidence without exposing unrelated or generated docs", async () => {
  project = await productWorkspace();
  const { workspace, brief } = project;
  const readme = "# Public module\nRun node --test test/value.test.mjs to verify the value.\n";
  await workspace.write("README.md", readme);
  await workspace.write("notes.md", "Unrelated notes should not enter the review.\n");
  await workspace.write(".agents/generated.md", "Generated agent instructions.\n");
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...brief,
        checks: brief.checks.map((check) => ({
          ...check,
          files: [...check.files, "README.md", ".agents/generated.md"],
        })),
      },
      reason: "Include documented verification instructions as check inputs",
    }),
  );
  const review = value(await runProductReview(await workspace.state()));
  expect(review.sources.find((source) => source.reference === "README.md")).toMatchObject({
    available: true,
    sha256: sha256(readme),
    excerpt: expect.stringContaining("Run node --test test/value.test.mjs"),
    truncated: false,
  });
  expect(review.sources.map((source) => source.reference)).not.toContain("notes.md");
  expect(review.sources.map((source) => source.reference)).not.toContain(".agents/generated.md");
});

it("keeps source citations resolvable through review, next, done and acceptance, rejecting changed source", async () => {
  project = await productWorkspace();
  const { workspace } = project;
  value(await runProductWork(await workspace.state()));
  await workspace.write("src/value.mjs", "export const value = 2;\n");
  value(await runProductDone(await workspace.state(), { task: "T001" }));
  const bundle = value(await runProductReview(await workspace.state()));
  const source = bundle.sources.find((s) => s.reference === "src/value.mjs");
  if (!source) throw new Error("Missing implementation source");
  const submission = {
    subjectDigest: bundle.subjectDigest,
    feedback: moduleFeedback(bundle),
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "The executed export equals two; source explains its owner",
        evidence: ["C001", source.id],
      },
    ],
  };
  const reviewed = value(await runProductReview(await workspace.state(), submission));
  expect(reviewed.assessments[0]?.status).toBe("satisfied");
  const repair = reviewInputTemplate(value(await runProductReview(await workspace.state())));
  expect(repair.assessments).toEqual([]);
  expect(repair.feedback.probes).toEqual([]);
  value(await runProductReview(await workspace.state(), repair));
  expect(value(await runProductNext(await workspace.state())).action).toBe("accept");
  const closed = value(await runProductDone(await workspace.state(), { task: "T001" }));
  expect(closed.closed, JSON.stringify(closed)).toBe(true);
  expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
  await workspace.write("src/value.mjs", "export const value = 3;\n");
  expect((await runProductReview(await workspace.state(), submission)).ok).toBe(false);
  expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
});
