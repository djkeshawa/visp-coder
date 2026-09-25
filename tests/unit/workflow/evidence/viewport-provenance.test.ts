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
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
});
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

it("keeps a claimed mobile viewport unassessed when only agent-supplied image metadata supports it", async () => {
  workspace = await TestWorkspace.create();
  await workspace.installFoundation();
  workspace.commit("foundation");
  const created = value(
    await createProductFeature(await workspace.state(), { goal: "Readable mobile output" }),
  );
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [
          {
            id: "O001",
            kind: "quality",
            statement: "Output is readable at the promised viewport",
            expectations: [
              {
                id: "E001",
                statement: "Inspect the rendered output at 390 by 844",
                viewport: { width: 390, height: 844 },
              },
            ],
          },
        ],
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
  const pixels = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  const path = ".visp/review-input.gif";
  await workspace.write(path, pixels);
  const before = value(await runProductReview(await workspace.state()));
  const reviewed = value(
    await runProductReview(await workspace.state(), {
      subjectDigest: before.subjectDigest,
      captures: [
        {
          id: "CAP-claimed-mobile",
          path,
          sha256: sha256(pixels),
          subjectDigest: before.subjectDigest,
          route: "/",
          steps: ["Reported inspection"],
          viewport: { width: 390, height: 844 },
          createdAt: new Date().toISOString(),
          provenance: "agent-supplied",
        },
      ],
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The supplied image is reportedly the mobile rendering",
          evidence: ["CAP-claimed-mobile"],
          expectations: [
            {
              id: "E001",
              status: "satisfied",
              reason: "The supplied metadata claims the requested viewport",
              evidence: ["CAP-claimed-mobile"],
            },
          ],
        },
      ],
    }),
  );
  expect(reviewed.images).toHaveLength(1);
  expect(reviewed.assessments[0]?.expectations[0]?.status).toBe("unavailable");
  expect(value(await runProductDone(await workspace.state())).passed).toBe(false);
});
