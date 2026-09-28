import { afterEach, expect, it } from "vitest";
import { productObservationSummary } from "../../../../src/workflow/evidence/observations-reader.js";
import type { ProductReviewBundle } from "../../../../src/workflow/product/review.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => project?.workspace.destroy());

it("filters observations by outcome and returns absolute image paths", async () => {
  project = await productWorkspace();
  const state = await project.workspace.state();
  const bundle = {
    feature: project.brief.feature,
    evidence: [
      {
        id: "CAP-1",
        kind: "image",
        status: "available",
        summary: "First image",
        outcomes: ["O001"],
      },
      { id: "CAP-2", kind: "image", status: "stale", summary: "Other image", outcomes: ["O002"] },
    ],
    images: [
      { id: "CAP-1", path: ".visp/images/first.png" },
      { id: "CAP-2", path: ".visp/images/other.png" },
    ],
  } as unknown as ProductReviewBundle;
  const result = productObservationSummary(state, bundle, "O001");
  expect(result.observations).toMatchObject([{ id: "CAP-1", status: "available" }]);
  expect(result.images).toEqual([
    { id: "CAP-1", path: state.paths.absolute(".visp/images/first.png") },
  ]);
});
