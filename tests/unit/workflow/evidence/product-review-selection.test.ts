import { afterEach, expect, it } from "vitest";
import { sha256 } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import {
  createProductFeature,
  updateProductBrief,
} from "../../../../src/workflow/product/brief.js";
import { runProductDone } from "../../../../src/workflow/product/evidence.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { recordedProductJourney } from "../../support/product-journey.js";
import { pngHeader, TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace;
afterEach(async () => {
  await workspace?.destroy();
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it("does not bind replacement pixels to a missing original capture through a reused ID", async () => {
  workspace = await TestWorkspace.create();
  await workspace.installFoundation();
  workspace.commit("foundation");
  const created = value(
    await createProductFeature(await workspace.state(), { goal: "Readable output" }),
  );
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [{ id: "O001", kind: "quality", statement: "The output is readable" }],
        slices: [
          {
            id: "T001",
            goal: "Readable output",
            outcomes: ["O001"],
            scope: { allowed: ["app.js"] },
          },
        ],
      },
    }),
  );
  value(await runProductWork(await workspace.state()));
  const [original] = await recordedProductJourney(workspace, "original");
  if (!original) throw new Error("Missing recorded capture fixture");
  await workspace.write(original.path, "corrupted original");
  const replacementPath = ".visp/replacement.png";
  const replacementBytes = pngHeader(100, 100);
  await workspace.write(replacementPath, replacementBytes);
  const reviewed = value(
    await runProductReview(await workspace.state(), {
      subjectDigest: original.subjectDigest,
      captures: [
        {
          ...original,
          path: replacementPath,
          sha256: sha256(replacementBytes),
          viewport: { width: 100, height: 100 },
        },
      ],
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The original capture reportedly demonstrates readable output",
          evidence: [original.id],
        },
      ],
    }),
  );
  expect(reviewed.assessments[0]?.status).toBe("unavailable");
  expect(reviewed.images.some((image) => image.id === original.id)).toBe(false);
  expect(reviewed.evidence.find((entry) => entry.id === original.id)?.status).toBe("unavailable");
  expect(reviewed.gaps.join("\n")).toContain("conflicting capture identity");
});

it.each(["id", "path"] as const)(
  "retains an explicitly linked older journey by %s within bounded review delivery",
  async (reference) => {
    workspace = await TestWorkspace.create();
    await workspace.installFoundation();
    workspace.commit("foundation");
    const created = value(
      await createProductFeature(await workspace.state(), {
        goal: "Show the beginning and end of an interaction",
      }),
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...created.brief,
          outcomes: [
            {
              id: "O001",
              kind: "experience",
              statement: "The transition communicates the result",
              expectations: [{ id: "E001", statement: "Inspect both ends of the interaction" }],
            },
          ],
          slices: [
            {
              id: "T001",
              goal: "Implement the transition",
              outcomes: ["O001"],
              scope: { allowed: ["app.js"] },
            },
          ],
        },
      }),
    );
    value(await runProductWork(await workspace.state()));
    const retained = await recordedProductJourney(workspace, "retained");
    for (let index = 0; index < 3; index++)
      await recordedProductJourney(workspace, `recent-${index}`);
    const bundle = value(await runProductReview(await workspace.state()));
    expect(bundle.images).toHaveLength(6);
    expect(bundle.images.some((image) => image.id.startsWith("retained"))).toBe(false);
    const options = {
      subjectDigest: bundle.subjectDigest,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The retained before and after images show the intended transition",
          evidence: [],
          expectations: [
            {
              id: "E001",
              status: "satisfied",
              reason: "Both states are readable and reflect the interaction",
              evidence: retained.map((capture) => capture[reference]),
            },
          ],
        },
      ],
    };
    const reviewed = value(await runProductReview(await workspace.state(), options));
    expect(reviewed.images).toHaveLength(6);
    expect(reviewed.images.slice(0, 2).map((image) => image.id)).toEqual(
      retained.map((capture) => capture.id),
    );
    expect(reviewed.assessments[0]?.status).toBe("satisfied");
    expect(value(await runProductDone(await workspace.state())).closed).toBe(true);

    // Prioritizing a reference never bypasses integrity validation.
    await workspace.write(retained[0]?.path ?? "missing", "changed image bytes");
    const corrupted = value(await runProductReview(await workspace.state(), options));
    expect(corrupted.assessments[0]?.status).toBe("unavailable");
    expect(corrupted.gaps.join("\n")).toContain("image changed since capture");
    expect(corrupted.images.some((image) => image.id === retained[0]?.id)).toBe(false);
  },
);
