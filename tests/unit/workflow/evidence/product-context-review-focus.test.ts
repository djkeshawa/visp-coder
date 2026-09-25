import { expect, it } from "vitest";
import { buildProductContext } from "../../../../src/workflow/product/context.js";
import { assessmentSchema } from "../../../../src/workflow/product/model.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

it("retains failures and limitations without resending old approval prose to the worker", async () => {
  const { workspace, brief } = await productWorkspace();
  try {
    const state = await workspace.state();
    const loaded = await readProductRecord(state);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const record = loaded.value;
    const slice = brief.slices[0];
    if (!slice) throw new Error("Fixture slice missing");
    const assessment = (status: "satisfied" | "failed") =>
      assessmentSchema.parse({
        outcome: "O001",
        status,
        summary: status === "satisfied" ? "APPROVAL_PROSE" : "Original input still fails",
      });
    const review = (summary: string, status: "satisfied" | "failed", limitations: string[]) => ({
      subjectDigest: "old",
      contractDigest: productContractDigest(brief, slice),
      task: slice.id,
      createdAt: "2026-09-16",
      captures: [],
      assessments: [assessment(status)],
      feedback: {
        phase: "product" as const,
        dimensions: [],
        findings: [],
        resolutions: [],
        summary,
        limitations,
      },
    });
    record.state.reviews.push(
      review("OLD_APPROVAL", "satisfied", []),
      review("OLDER_DIAGNOSIS", "failed", ["Touch input unobserved"]),
      review("Latest observed result", "satisfied", []),
    );
    const before = JSON.stringify(record.state);
    const result = await buildProductContext(state, record, slice, {}, true, false);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.reviewFeedback).toHaveLength(2);
    expect(result.value.reviewFeedback[0]).toMatchObject({
      assessments: [{ status: "failed", summary: "Original input still fails" }],
      limitations: ["Touch input unobserved"],
    });
    expect(result.value.reviewFeedback[1]).toMatchObject({
      summary: "Latest observed result",
      assessments: [],
    });
    expect(JSON.stringify(result.value.reviewFeedback)).not.toMatch(
      /OLD_APPROVAL|APPROVAL_PROSE|OLDER_DIAGNOSIS/,
    );
    expect(JSON.stringify(record.state)).toBe(before);
    expect(result.value.outcomes).toEqual(brief.outcomes);
    expect(result.value.scope).toEqual(slice.scope);
  } finally {
    await workspace.destroy();
  }
});
