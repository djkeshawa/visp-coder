import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashValue } from "../../../../src/core/hash.js";
import type { Result } from "../../../../src/core/result.js";
import {
  applicableExecutions,
  applicableReviews,
} from "../../../../src/workflow/product/assessment.js";
import {
  createProductFeature,
  updateProductBrief,
} from "../../../../src/workflow/product/brief.js";
import {
  runProductAccept,
  runProductDone,
  runProductVerify,
} from "../../../../src/workflow/product/evidence.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { runProductNext, runProductStatus } from "../../../../src/workflow/product/status.js";
import { historicalAcceptanceNext } from "../../../../src/workflow/product/status-history.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import * as identity from "../../../../src/workflow/product/subject.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { TestWorkspace } from "../../support/workspace.js";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
};
let workspace: TestWorkspace;
let feature: string;
beforeEach(async () => {
  workspace = await TestWorkspace.create({
    "value.cjs": "module.exports=2;",
    "helper.cjs": "exports.read=()=>require('./value.cjs');",
  });
  await workspace.installFoundation();
  workspace.commit("foundation");
  const created = value(
    await createProductFeature(await workspace.state(), {
      goal: "Produce value two",
      sourceBrief: "Produce value two",
    }),
  );
  feature = created.brief.feature;
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "Produce value two",
            expectations: [
              { id: "E001", statement: "The public value is two", provenance: "agent-proposed" },
            ],
          },
        ],
        examples: [
          {
            id: "SCN001",
            title: "Read the value",
            when: "The helper reads the public module",
            expected: ["Value two is returned"],
            outcomes: ["O001"],
          },
        ],
        uncertainties: ["Does the indirect helper reach the public value?"],
        decisions: [
          {
            id: "D001",
            statement: "Keep the public module separate",
            implications: ["Exercise the real helper"],
            outcomes: ["O001"],
          },
        ],
        checks: [
          {
            id: "C001",
            command: [
              process.execPath,
              "-e",
              "require('node:assert/strict').equal(require('./helper.cjs').read(),2)",
            ],
            outcomes: ["O001"],
            environment: "node",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Public value",
            outcomes: ["O001"],
            checks: ["C001"],
            scope: { allowed: ["value.cjs"] },
          },
        ],
      },
    }),
  );
  value(await runProductWork(await workspace.state()));
  value(await runProductDone(await workspace.state()));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace?.destroy();
});

async function submit(evidence = ["C001"], expectations = true) {
  const bundle = value(await runProductReview(await workspace.state()));
  return runProductReview(await workspace.state(), {
    subjectDigest: bundle.subjectDigest,
    feedback: moduleFeedback(bundle),
    coverage: bundle.challenges.map((challenge) => ({
      id: challenge.id,
      status: "satisfied",
      reason: "The executed equality assertion read value two through the actual helper",
      evidence,
    })),
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary: "The helper executes the public module and returns two",
        evidence,
        expectations: expectations
          ? [
              {
                id: "E001",
                status: "satisfied",
                reason: "The actual equality check read two through the helper",
                evidence,
              },
            ]
          : [],
      },
    ],
  });
}

describe("supported product judgments", () => {
  it.each([false, true])(
    "retains a legacy-contract negative only for the unchanged implementation (stale: %s)",
    async (stale) => {
      value(await submit());
      expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
      const accepted = value(await readProductRecord(await workspace.state()));
      const bundle = value(await runProductReview(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: bundle.subjectDigest,
          feedback: moduleFeedback(bundle),
          assessments: [
            {
              outcome: "O001",
              status: "failed",
              summary: "The previous runtime observed a consequential mismatch",
              evidence: ["C001"],
            },
          ],
        }),
      );
      const record = value(await readProductRecord(await workspace.state()));
      const legacy = identity.legacyFeatureContractDigest(record.brief);
      record.state.acceptedContract = legacy;
      delete record.state.acceptedReviewPolicy;
      for (const review of record.state.reviews.slice(0, accepted.state.reviews.length))
        delete review.policyVersion;
      for (const review of record.state.reviews) if (!review.task) review.contractDigest = legacy;
      const negative = record.state.reviews.at(-1);
      if (!negative) throw new Error("Expected the later negative judgment");
      if (stale) {
        negative.subjectDigest = "c".repeat(64);
        negative.implementationDigest = "d".repeat(64);
      }
      const path = `.visp/features/${feature}/product-state.json`;
      await workspace.write(path, JSON.stringify(record.state));
      const before = await readFile(join(workspace.root, path), "utf8");
      const next = value(await runProductNext(await workspace.state()));
      expect(next).toMatchObject({ action: stale ? "complete" : "refine", mayEdit: false });
      expect(value(await runProductStatus(await workspace.state())).next.action).toBe(next.action);
      expect(await readFile(join(workspace.root, path), "utf8")).toBe(before);
      if (stale) return;
      expect(next.evidence.join()).toContain("consequential mismatch");
      // A legacy positive cannot provide fresh credit or erase the retained negative.
      record.state.reviews.push({
        ...negative,
        assessments: [
          {
            outcome: "O001",
            provenance: "agent-reported",
            status: "satisfied",
            summary: "Legacy positive",
            evidence: ["C001"],
            expectations: [
              {
                id: "E001",
                status: "satisfied",
                reason: "Legacy interpretation",
                evidence: ["C001"],
              },
            ],
          },
        ],
      });
      await workspace.write(path, JSON.stringify(record.state));
      expect(value(await runProductNext(await workspace.state())).action).toBe("refine");
      expect(applicableReviews(record, bundle.subjectDigest)).toEqual([]);
      value(await submit());
      expect(value(await runProductNext(await workspace.state()))).toMatchObject({
        action: "complete",
        objective: expect.stringContaining("previous review policy"),
      });
    },
  );

  it("preserves the legacy feature contract only for read-only historical acceptance", async () => {
    value(await submit());
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    // Exact pre-method-identity format, independently reconstructed from the old fields.
    const legacy = hashValue({
      originalRequest: record.brief.originalRequest,
      outcomes: record.brief.outcomes,
      examples: record.brief.examples,
      checks: record.brief.checks,
      acceptanceBaseline: record.brief.acceptanceBaseline,
      design: record.brief.design,
    });
    expect(legacy).not.toBe(identity.productContractDigest(record.brief));
    record.state.acceptedContract = legacy;
    delete record.state.acceptedReviewPolicy;
    for (const review of record.state.reviews) {
      delete review.policyVersion;
      if (!review.task) review.contractDigest = legacy;
    }
    for (const execution of record.state.executions)
      if (!execution.task) execution.contractDigest = legacy;
    const path = `.visp/features/${feature}/product-state.json`;
    await workspace.write(path, JSON.stringify(record.state));
    const before = await readFile(join(workspace.root, path), "utf8");
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "complete",
      objective: expect.stringContaining("previous review policy"),
    });
    expect(value(await runProductStatus(await workspace.state())).next.action).toBe("complete");
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(before);
    const subject = value(
      await identity.productSourceDigest(await workspace.state(), record.brief),
    );
    expect(applicableReviews(record, subject)).toEqual([]);
    expect(applicableExecutions(record, subject).filter((entry) => !entry.task)).toEqual([]);
    record.state.acceptedReviewPolicy = 5;
    await workspace.write(path, JSON.stringify(record.state));
    expect(value(await runProductNext(await workspace.state())).action).not.toBe("complete");
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });

  it("preserves historical implementation identity across a runtime upgrade without relabeling changed or unidentifiable code", async () => {
    value(await submit());
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    delete record.state.acceptedReviewPolicy;
    for (const review of record.state.reviews) delete review.policyVersion;
    const path = `.visp/features/${feature}/product-state.json`;
    await workspace.write(path, JSON.stringify(record.state));
    vi.spyOn(identity, "productSourceDigest").mockResolvedValue({
      ok: true,
      value: "b".repeat(64),
    });
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "complete",
      objective: expect.stringContaining("previous review policy"),
    });
    await workspace.write("value.cjs", "module.exports=3;");
    expect(value(await runProductNext(await workspace.state())).action).not.toBe("complete");
    for (const review of record.state.reviews) delete review.implementationDigest;
    await workspace.write(path, JSON.stringify(record.state));
    const before = await readFile(join(workspace.root, path), "utf8");
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "understand",
      objective: expect.stringContaining("freshness is unknown"),
    });
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(before);
  });
  it("retains every unresolved row while delivering at most three actionable findings", async () => {
    const record = value(await readProductRecord(await workspace.state()));
    const outcomes = [
      ...record.brief.outcomes,
      ...[2, 3, 4].map((id) => ({
        id: `O00${id}`,
        kind: "quality",
        statement: `Retained promise ${id}`,
      })),
    ];
    value(
      await updateProductBrief(await workspace.state(), {
        reason: "Retain the additional promises",
        brief: { ...record.brief, outcomes },
      }),
    );
    const bundle = value(await runProductReview(await workspace.state()));
    const result = value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback: moduleFeedback(bundle),
        assessments: outcomes.map((outcome) => ({
          outcome: outcome.id,
          status: "failed",
          summary: "The promise remains unresolved",
        })),
      }),
    );
    expect(result.assessments).toHaveLength(4);
    expect(result.findings).toHaveLength(3);
    expect(result.refinement.used).toBe(0);
  });
  it("validates source quotes beyond the delivered excerpt without claiming authenticated independence", async () => {
    const created = value(
      await createProductFeature(await workspace.state(), {
        goal: "Quoted source",
        sourceBrief: `${"Context ".repeat(700)}A distinct retained promise`,
      }),
    );
    value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...created.brief,
          outcomes: [
            {
              kind: "quality",
              statement: "A distinct retained promise",
              provenance: "independent",
              source: "SRC-REQUEST",
              sourceQuote: "A distinct retained promise",
            },
          ],
        },
      }),
    );
    const bundle = value(await runProductReview(await workspace.state()));
    expect(bundle.sources[0]?.excerpt).not.toContain("A distinct retained promise");
    expect(bundle.sourceClaims[0]).toMatchObject({
      sourceStatus: "identified",
      reportedProvenance: "independent",
    });
    expect(bundle.sourceClaims[0]?.qualification).toContain("does not authenticate");
  });
  it("keeps an explicit missing viewport observation unresolved despite a passing Node check", async () => {
    const record = value(await readProductRecord(await workspace.state()));
    value(
      await updateProductBrief(await workspace.state(), {
        intentChange: {
          reason: "Retain an explicitly supplied viewport promise",
          provenance: "test supplied",
        },
        brief: {
          ...record.brief,
          outcomes: record.brief.outcomes.map((outcome) => ({
            ...outcome,
            expectations: outcome.expectations.map((expectation) => ({
              ...expectation,
              viewport: { width: 390, height: 844 },
            })),
          })),
        },
      }),
    );
    value(await runProductVerify(await workspace.state()));
    const result = value(await submit());
    expect(result.assessments[0]?.expectations[0]?.status).toBe("unavailable");
    expect(result.assessments[0]?.summary).toContain("390×844");
    expect(result.refinement.used).toBe(0);
  });
  it("does not credit a check explicitly mapped only to another outcome", async () => {
    const record = value(await readProductRecord(await workspace.state()));
    value(
      await updateProductBrief(await workspace.state(), {
        reason: "Retain a separate promise and check",
        brief: {
          ...record.brief,
          outcomes: [
            ...record.brief.outcomes,
            { id: "O002", kind: "quality", statement: "Another promise" },
          ],
          checks: [
            ...record.brief.checks,
            { ...record.brief.checks[0], id: "C002", outcomes: ["O002"] },
          ],
        },
      }),
    );
    value(await runProductVerify(await workspace.state()));
    expect(value(await submit(["C002"])).assessments[0]).toMatchObject({
      status: "unavailable",
      summary: expect.stringContaining("mapping does not include O001"),
    });
  });
  it("rejects a nonexistent reference through public submission without recording a review", async () => {
    expect(await submit(["NONEXISTENT_EVIDENCE_ID"])).toMatchObject({
      ok: false,
      error: { code: "EVIDENCE_FAILED" },
    });
    expect(value(await readProductRecord(await workspace.state())).state.reviews).toEqual([]);
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });
  it("resolves check shorthand to actual execution and accepts a valid indirect helper", async () => {
    const reviewed = value(await submit());
    const execution = reviewed.executions.at(-1);
    expect(reviewed.assessments[0]?.evidence).toEqual([execution?.id]);
    expect(reviewed.assessments[0]?.expectations[0]?.evidence).toEqual([execution?.id]);
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    expect(value(await readProductRecord(await workspace.state())).state.acceptedReviewPolicy).toBe(
      5,
    );
  });
  it("does not use a passing command to invent a missing agent-proposed obligation judgment", async () => {
    value(await submit(["C001"], false));
    const accepted = value(await runProductAccept(await workspace.state()));
    expect(accepted.passed).toBe(false);
    expect(accepted.gaps.join()).toContain("E001");
  });
  it("keeps unsupported positive judgments unavailable when no evidence is linked", async () => {
    expect(value(await submit([])).assessments[0]?.status).toBe("unavailable");
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });
  it("delivers existing examples, decisions, uncertainties and check mappings to the reviewer", async () => {
    const review = value(await runProductReview(await workspace.state()));
    expect(review.agenda.examples[0]?.expected).toEqual(["Value two is returned"]);
    expect(review.agenda.decisions[0]?.implications).toEqual(["Exercise the real helper"]);
    expect(review.agenda.uncertainties).toContain(
      "Does the indirect helper reach the public value?",
    );
    expect(review.agenda.checks[0]?.outcomes).toEqual(["O001"]);
    expect(review.sourceClaims[0]).toMatchObject({
      reportedProvenance: "agent-proposed",
      sourceStatus: "unsubstantiated",
    });
    expect(review.sources[0]).toMatchObject({
      id: "SRC-REQUEST",
      available: true,
      excerpt: "Produce value two",
    });
  });
  it("delivers both scoped failure and later feature-wide pass for a shared check", async () => {
    const record = value(await readProductRecord(await workspace.state()));
    const original = record.state.executions.find((entry) => entry.task === "T001");
    if (!original) throw new Error("Missing scoped execution");
    record.state.executions.push(
      { ...original, id: "EXEC-SCOPED-FAIL", status: "failed", exitCode: 1 },
      {
        ...original,
        id: "EXEC-FEATURE-PASS",
        task: undefined,
        contractDigest: identity.productContractDigest(record.brief),
      },
    );
    await workspace.write(
      `.visp/features/${feature}/product-state.json`,
      JSON.stringify(record.state),
    );

    const review = value(await runProductReview(await workspace.state(), { task: "T001" }));
    expect(review.executions.map((entry) => entry.id)).toContain("EXEC-SCOPED-FAIL");
    expect(review.executions.map((entry) => entry.id)).toContain("EXEC-FEATURE-PASS");
    expect(review.evidence.find((entry) => entry.id === "EXEC-SCOPED-FAIL")?.status).toBe("failed");
  });
  it("reopens an accepted slice when a later feature-wide pass leaves its failure unresolved", async () => {
    value(await submit());
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    const original = record.state.executions.find((entry) => entry.task === "T001");
    if (!original) throw new Error("Missing scoped execution");
    record.state.executions.push(
      { ...original, id: "EXEC-SCOPED-FAIL", status: "failed", exitCode: 1 },
      {
        ...original,
        id: "EXEC-FEATURE-PASS",
        task: undefined,
        contractDigest: identity.productContractDigest(record.brief),
      },
    );
    await workspace.write(
      `.visp/features/${feature}/product-state.json`,
      JSON.stringify(record.state),
    );

    const next = value(await runProductNext(await workspace.state(), { task: "T001" }));
    expect(next.action).not.toBe("complete");
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });
  it("preserves unchanged historical acceptance on read but requires fresh policy evidence on explicit acceptance", async () => {
    value(await submit());
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    delete record.state.acceptedReviewPolicy;
    for (const review of record.state.reviews) delete review.policyVersion;
    const path = `.visp/features/${feature}/product-state.json`;
    await workspace.write(path, JSON.stringify(record.state));
    const before = await readFile(join(workspace.root, path), "utf8");
    expect(value(await runProductNext(await workspace.state()))).toMatchObject({
      action: "complete",
      objective: expect.stringContaining("previous review policy"),
    });
    expect(await readFile(join(workspace.root, path), "utf8")).toBe(before);
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });
  it("does not let another slice's later review hide a failed shared-outcome judgment", async () => {
    value(await submit());
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
    const record = value(await readProductRecord(await workspace.state()));
    const first = record.brief.slices[0];
    const reviewed = record.state.reviews.at(-1);
    const assessment = reviewed?.assessments[0];
    const subject = record.state.acceptedSubject;
    if (!first || !reviewed || !assessment || !subject)
      throw new Error("Missing accepted fixture evidence");
    const second = { ...first, id: "T002" };
    const brief = { ...record.brief, slices: [first, second] };
    const oldReviews = record.state.reviews.map((entry) => ({
      ...entry,
      policyVersion: undefined,
    }));
    const historical = {
      ...record,
      brief,
      state: {
        ...record.state,
        acceptedReviewPolicy: undefined,
        acceptedContract: identity.productContractDigest(brief),
        reviews: oldReviews,
      },
    };
    const selection = { subject, implementation: "same implementation" };
    expect(historicalAcceptanceNext(historical, selection, { feature })?.action).toBe("complete");
    const failed = {
      ...reviewed,
      policyVersion: 5 as const,
      task: "T001",
      contractDigest: identity.productContractDigest(brief, first),
      assessments: [{ ...assessment, status: "failed" as const }],
    };
    const otherPass = {
      ...reviewed,
      policyVersion: 5 as const,
      task: "T002",
      contractDigest: identity.productContractDigest(brief, second),
    };
    const contradicted = {
      ...historical,
      state: { ...historical.state, reviews: [...oldReviews, failed, otherPass] },
    };
    expect(historicalAcceptanceNext(contradicted, selection, { feature })).toBeUndefined();
    const repaired = {
      ...contradicted,
      state: {
        ...contradicted.state,
        reviews: [...contradicted.state.reviews, { ...failed, assessments: [assessment] }],
      },
    };
    expect(historicalAcceptanceNext(repaired, selection, { feature })?.action).toBe("complete");
    const legacyNegative = {
      ...reviewed,
      policyVersion: 2 as const,
      task: undefined,
      contractDigest: identity.legacyFeatureContractDigest(brief),
      assessments: [{ ...assessment, status: "failed" as const }],
    };
    const narrowerPass = {
      ...historical,
      state: {
        ...historical.state,
        reviews: [...oldReviews, legacyNegative, otherPass],
      },
    };
    expect(historicalAcceptanceNext(narrowerPass, selection, { feature })?.action).toBe("refine");
    const globalPass = {
      ...otherPass,
      task: undefined,
      contractDigest: identity.productContractDigest(brief),
    };
    const cleared = {
      ...narrowerPass,
      state: { ...narrowerPass.state, reviews: [...oldReviews, legacyNegative, globalPass] },
    };
    expect(historicalAcceptanceNext(cleared, selection, { feature })?.action).toBe("complete");
  });
  it.each(["outcome", "expectation"])(
    "keeps a new failed %s visible after historical acceptance",
    async (failure) => {
      value(await submit());
      expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
      const record = value(await readProductRecord(await workspace.state()));
      delete record.state.acceptedReviewPolicy;
      for (const review of record.state.reviews) delete review.policyVersion;
      const path = `.visp/features/${feature}/product-state.json`;
      await workspace.write(path, JSON.stringify(record.state));
      const bundle = value(await runProductReview(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: bundle.subjectDigest,
          feedback: moduleFeedback(bundle),
          assessments: [
            {
              outcome: "O001",
              status: failure === "outcome" ? "failed" : "satisfied",
              summary: "The current implementation does not satisfy the observed goal",
              evidence: ["C001"],
              expectations: [
                {
                  id: "E001",
                  status: failure === "expectation" ? "failed" : "satisfied",
                  reason: "The reviewer observed a mismatch despite the weak check",
                  evidence: ["C001"],
                },
              ],
            },
          ],
        }),
      );
      const beforeRead = await readFile(join(workspace.root, path), "utf8");
      expect(value(await runProductNext(await workspace.state()))).toMatchObject({
        action: "fix",
        task: "T001",
        mayEdit: false,
      });
      expect(await readFile(join(workspace.root, path), "utf8")).toBe(beforeRead);
      value(await submit());
      expect(value(await runProductNext(await workspace.state())).action).toBe("complete");
    },
  );
  it.each(["unavailable", "unclear"])(
    "keeps a newly %s mandatory judgment unresolved after historical acceptance",
    async (status) => {
      value(await submit());
      expect(value(await runProductAccept(await workspace.state())).passed).toBe(true);
      const record = value(await readProductRecord(await workspace.state()));
      delete record.state.acceptedReviewPolicy;
      for (const review of record.state.reviews) delete review.policyVersion;
      await workspace.write(
        `.visp/features/${feature}/product-state.json`,
        JSON.stringify(record.state),
      );
      const bundle = value(await runProductReview(await workspace.state()));
      value(
        await runProductReview(await workspace.state(), {
          subjectDigest: bundle.subjectDigest,
          feedback: moduleFeedback(bundle),
          assessments: [
            {
              outcome: "O001",
              status,
              summary: "The required product judgment cannot currently be established",
              evidence: ["C001"],
            },
          ],
        }),
      );
      expect(value(await runProductNext(await workspace.state()))).toMatchObject({
        action: "refine",
        mayEdit: false,
      });
    },
  );
  it("does not let a later failed execution hide behind the earlier passing reference", async () => {
    const reviewed = value(await submit());
    await workspace.write("value.cjs", "module.exports=3;");
    value(await runProductVerify(await workspace.state()));
    const bundle = value(await runProductReview(await workspace.state()));
    const oldReference = reviewed.assessments[0]?.evidence ?? [];
    const result = value(
      await runProductReview(await workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback: moduleFeedback(bundle),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "Claims old check is enough",
            evidence: oldReference,
          },
        ],
      }),
    );
    expect(result.assessments[0]?.status).toBe("unavailable");
    expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
  });
});
