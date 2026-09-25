import { describe, expect, it } from "vitest";
import type { ProductReviewImage } from "../../../../src/workflow/evidence/product-review.js";
import type { ProductEvidenceCatalogue } from "../../../../src/workflow/product/evidence-references.js";
import type { ProductOutcome } from "../../../../src/workflow/product/model.js";
import { validateAssessments } from "../../../../src/workflow/product/review-validation.js";

const subject = "a".repeat(64);
const images: ProductReviewImage[] = ["before", "after"].map((id) => ({
  id,
  path: `.visp/${id}.png`,
  sha256: "b".repeat(64),
  subjectDigest: subject,
  route: "/",
  steps: [id],
  viewport: { width: 640, height: 480 },
  createdAt: "2026-01-01T00:00:00Z",
  provenance: "runner-captured",
  mimeType: "image/png",
  data: "",
}));
const run = {
  id: "run-1",
  version: 2,
  status: "completed",
  provenance: "runner-executed",
  subjectDigest: subject,
  captures: images,
  operations: [
    { id: "op-before", kind: "capture", captureId: "before", completedAt: "1" },
    { id: "op-input", kind: "pointer", completedAt: "2" },
    { id: "op-after", kind: "capture", captureId: "after", completedAt: "3" },
  ],
};
const outcome: ProductOutcome = {
  id: "O001",
  kind: "experience",
  priority: "must",
  statement: "The interaction is usable",
  provenance: "agent-proposed",
  reviewRequired: true,
  expectations: [],
};
const execution = {
  id: "exec-1",
  kind: "execution" as const,
  status: "available" as const,
  outcomes: ["O001"],
  summary: "Actual journey",
  captureRunId: run.id,
};
const catalogue: ProductEvidenceCatalogue = {
  entries: [
    execution,
    ...images.map((image) => ({
      id: image.id,
      kind: "image" as const,
      status: "available" as const,
      outcomes: [],
      summary: image.path,
    })),
  ],
  aliases: new Map([["C001", execution.id]]),
  sources: [],
  sourceClaims: [],
};
function assess(
  options: {
    evidence?: string[];
    runs?: unknown[];
    selected?: ProductReviewImage[];
    entries?: ProductEvidenceCatalogue["entries"];
    status?: string;
  } = {},
) {
  return validateAssessments(
    {
      subjectDigest: subject,
      assessments: [
        {
          outcome: "O001",
          status: options.status ?? "satisfied",
          summary: "Reviewer judgment",
          evidence: options.evidence ?? ["C001"],
        },
      ],
    },
    subject,
    [outcome],
    options.selected ?? images,
    () => options.runs ?? [run],
    { ...catalogue, entries: options.entries ?? catalogue.entries },
  );
}
describe("tool-owned review image links", () => {
  it("derives a selected before/after pair from a cited execution, preserving the judgment", () => {
    expect(assess()).toMatchObject({
      ok: true,
      value: [
        {
          status: "satisfied",
          evidence: ["exec-1", "before", "after"],
          summary: "Reviewer judgment",
        },
      ],
    });
  });
  it("never promotes a failed or unavailable judgment", () => {
    for (const status of ["failed", "unavailable"])
      expect(assess({ status })).toMatchObject({ ok: true, value: [{ status }] });
  });
  it("retains explicit image citations and does not infer from an after image alone", () => {
    expect(assess({ evidence: ["before", "after"] })).toMatchObject({
      ok: true,
      value: [{ status: "satisfied" }],
    });
    expect(assess({ evidence: ["after"] })).toMatchObject({
      ok: true,
      value: [
        { status: "unavailable", summary: expect.stringContaining("No recapture is needed") },
      ],
    });
  });
  it("does not bind stale, failed, mismatched or cross-run captures", () => {
    for (const runs of [
      [{ ...run, subjectDigest: "c".repeat(64) }],
      [{ ...run, status: "failed" }],
      [{ ...run, id: "other" }],
      [{ ...run, captures: images.map((image) => ({ ...image, sha256: "d".repeat(64) })) }],
      [
        { ...run, operations: run.operations.slice(0, 2) },
        { ...run, id: "other", operations: run.operations.slice(1) },
      ],
      [{ ...run, operations: [...run.operations, run.operations[1]] }],
    ])
      expect(assess({ runs })).toMatchObject({ ok: true, value: [{ status: "unavailable" }] });
  });
  it("cannot add images outside the selected session or unavailable in the catalogue", () => {
    expect(assess({ selected: images.slice(1) })).toMatchObject({
      ok: true,
      value: [{ status: "unavailable", evidence: ["exec-1"] }],
    });
    for (const status of ["not-delivered", "stale", "unavailable"] as const) {
      expect(
        assess({
          entries: catalogue.entries.map((entry) =>
            entry.id === "before" ? { ...entry, status } : entry,
          ),
        }),
      ).toMatchObject({ ok: true, value: [{ status: "unavailable" }] });
    }
  });
  it("cannot use a failed, stale or differently mapped execution", () => {
    for (const changed of [
      { ...execution, status: "failed" as const },
      { ...execution, status: "stale" as const },
      { ...execution, outcomes: ["O002"] },
    ]) {
      expect(assess({ entries: [changed, ...catalogue.entries.slice(1)] })).toMatchObject({
        ok: true,
        value: [{ status: "unavailable", evidence: ["exec-1"] }],
      });
    }
  });
  it("derives viewport evidence per expectation without widening explicit citations", () => {
    const mobileImages = images.map((image) => ({
      ...image,
      id: `mobile-${image.id}`,
      path: `.visp/mobile-${image.id}.png`,
      viewport: { width: 390, height: 844 },
    }));
    const mobileRun = {
      ...run,
      id: "mobile-run",
      captures: mobileImages,
      operations: run.operations.map((operation) => ({
        ...operation,
        captureId: operation.captureId ? `mobile-${operation.captureId}` : undefined,
      })),
    };
    const entries = [
      execution,
      { ...execution, id: "mobile-exec", captureRunId: mobileRun.id },
      ...[...images, ...mobileImages].map((image) => ({
        id: image.id,
        kind: "image" as const,
        status: "available" as const,
        outcomes: [],
        summary: image.path,
        viewport: image.viewport,
      })),
    ];
    const expected = {
      id: "O001-E1",
      statement: "Mobile input is usable",
      provenance: "agent-proposed" as const,
      viewport: { width: 390, height: 844 },
    };
    for (const evidence of [["mobile-exec"], ["exec-1"]]) {
      const result = validateAssessments(
        {
          subjectDigest: subject,
          assessments: [
            {
              outcome: "O001",
              status: "satisfied",
              summary: "Inspected both viewports",
              evidence: ["exec-1", "mobile-exec"],
              expectations: [
                {
                  id: expected.id,
                  status: "satisfied",
                  reason: "Inspected the requested viewport",
                  evidence,
                },
              ],
            },
          ],
        },
        subject,
        [{ ...outcome, expectations: [expected] }],
        [...images, ...mobileImages],
        () => [run, mobileRun],
        { ...catalogue, entries },
      );
      expect(result).toMatchObject({
        ok: true,
        value: [{ status: evidence[0] === "mobile-exec" ? "satisfied" : "unavailable" }],
      });
      if (result.ok)
        expect(result.value[0]?.expectations[0]?.evidence).not.toContain(
          evidence[0] === "mobile-exec" ? "before" : "mobile-before",
        );
    }
  });
});
