import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductReview, updateProductBrief } from "../../../../src/workflow/product/index.js";
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
