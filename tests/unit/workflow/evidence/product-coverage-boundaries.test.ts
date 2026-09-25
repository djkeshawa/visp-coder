import { afterEach, describe, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { finalProductAssessmentGaps } from "../../../../src/workflow/product/assessment.js";
import {
  applyCoverageFailures,
  currentCoverage,
  productReviewChallenges,
  validateCoverage,
} from "../../../../src/workflow/product/coverage.js";
import type {
  ProductEvidenceCatalogue,
  ProductEvidenceReference,
} from "../../../../src/workflow/product/evidence-references.js";
import {
  runProductAccept,
  runProductDone,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import {
  initialProductState,
  PRODUCT_REVIEW_POLICY,
  productBriefSchema,
} from "../../../../src/workflow/product/model.js";
import type { ProductRecord } from "../../../../src/workflow/product/store.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productContractDigest } from "../../../../src/workflow/product/subject.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>> | undefined;
afterEach(async () => {
  await project?.workspace.destroy();
  project = undefined;
});
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function satisfiedOutcomeWithUnassessedExample() {
  project = await productWorkspace();
  const { workspace } = project;
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...project.brief,
        examples: [
          {
            id: "E001",
            title: "Numeric conversion",
            given: ["Text input"],
            when: "getValue('2')",
            expected: ["The result is numeric two"],
            outcomes: ["O001"],
          },
        ],
      },
      intentChange: { reason: "Retain input behavior", provenance: "test oracle" },
    }),
  );
  value(await runProductWork(await workspace.state()));
  await workspace.write(
    "src/value.mjs",
    "export const value = 2; export const getValue = input => input;\n",
  );
  expect(value(await runProductDone(await workspace.state())).closed).toBe(true);
  const bundle = value(await runProductReview(await workspace.state()));
  value(
    await runProductReview(await workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The basic check passes",
          evidence: ["C001"],
        },
      ],
    }),
  );
  // Legacy coverage is optional until supplied; this fixture preserves a prior positive outcome.
  return { workspace, bundle };
}

const challenge = {
  id: "EX-one",
  example: "E001",
  title: "Required behavior",
  given: [],
  when: "act",
  expected: "result",
  outcomes: ["O001", "O003"],
  required: true,
};
const reported = {
  id: challenge.id,
  status: "satisfied" as const,
  reason: "An observed result",
  evidence: ["C001"],
};
function catalogue(
  outcomes: string[],
  status: ProductEvidenceReference["status"] = "available",
): ProductEvidenceCatalogue {
  return {
    entries: [
      { id: "EXEC-one", kind: "execution", status, summary: "Executed behavior check", outcomes },
    ],
    aliases: new Map([["C001", "EXEC-one"]]),
    sources: [],
    sourceClaims: [],
  };
}

describe("coverage evidence scope", () => {
  it("rechecks stored functional coverage instead of trusting a syntax-only receipt", async () => {
    project = await productWorkspace();
    const { workspace } = project;
    project.brief = value(
      await updateProductBrief(await workspace.state(), {
        brief: {
          ...project.brief,
          examples: [
            {
              id: "E001",
              title: "Public value",
              given: [],
              when: "Read the public value",
              expected: ["The value is two"],
              outcomes: ["O001"],
            },
          ],
          checks: [
            ...project.brief.checks,
            {
              id: "C002",
              command: [process.execPath, "--check", "src/value.mjs"],
              outcomes: ["O001"],
              files: ["src/value.mjs"],
              environment: "node",
            },
          ],
          slices: project.brief.slices.map((slice) => ({
            ...slice,
            checks: [...slice.checks, "C002"],
          })),
        },
        reason: "Retain an example with a separate syntax check",
      }),
    );
    value(await runProductWork(await workspace.state()));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(value(await runProductDone(await workspace.state())).closed).toBe(true);

    const record = value(await readProductRecord(await workspace.state()));
    const challenge = productReviewChallenges(record)[0];
    const execution = record.state.executions.find((entry) => entry.check === "C002");
    if (!challenge || !execution) throw new Error("Expected the syntax check and example");
    record.state.reviews.push({
      policyVersion: PRODUCT_REVIEW_POLICY,
      subjectDigest: execution.subjectDigest,
      contractDigest: productContractDigest(record.brief),
      createdAt: "now",
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The executable check passed",
          evidence: ["C001"],
          expectations: [],
          provenance: "agent-reported",
        },
      ],
      coverage: [
        {
          id: challenge.id,
          status: "satisfied",
          reason: "The syntax check passed",
          evidence: ["C002"],
        },
      ],
      captures: [],
    });
    await workspace.write(
      `.visp/features/${record.brief.feature}/product-state.json`,
      JSON.stringify(record.state),
    );

    const accepted = value(await runProductAccept(await workspace.state()));
    expect(accepted.passed).toBe(false);
    expect(accepted.gaps).toContainEqual(
      expect.stringContaining(
        `${challenge.id}: No current execution or observation supports this judgment`,
      ),
    );
  });

  it.each([
    [["O002"], "unavailable"],
    [["O003"], "satisfied"],
    [["O002", "O001"], "satisfied"],
    [[], "satisfied"],
  ] as const)(
    "checks declared overlap without inventing a universal mapping: %j",
    (outcomes, status) => {
      const result = value(validateCoverage([reported], [challenge], catalogue([...outcomes])));
      expect(result[0]?.status).toBe(status);
      expect(result[0]?.evidence).toEqual(["EXEC-one"]);
      if (status === "unavailable")
        expect(result[0]?.reason).toContain("does not include any challenge outcome");
    },
  );
  it.each(["stale", "failed", "unavailable", "not-delivered"] as const)(
    "does not credit %s evidence even with matching declared scope",
    (status) => {
      const result = value(validateCoverage([reported], [challenge], catalogue(["O001"], status)));
      expect(result[0]?.status).toBe("unavailable");
    },
  );
});

it("does not let an unavailable coverage-only reviewer fill required gaps while preserving an earlier positive outcome", async () => {
  const { workspace, bundle } = await satisfiedOutcomeWithUnassessedExample();
  const review = value(
    await runProductReview(await workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      reviewer: { context: "unavailable", reason: "Host cannot inspect current behavior" },
      assessments: [],
      coverage: bundle.challenges.map((entry) => ({
        id: entry.id,
        status: "satisfied",
        reason: "Claimed positive coverage despite unavailable reviewer",
        evidence: ["C001"],
      })),
    }),
  );
  expect(review.reviewer.context).toBe("unavailable");
  expect(review.coverage[0]?.status).toBe("unavailable");
  expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
});

it("carries coverage-only failures to prior parent assessments on submission and reread", async () => {
  const { workspace, bundle } = await satisfiedOutcomeWithUnassessedExample();
  const submitted = value(
    await runProductReview(await workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      assessments: [],
      coverage: [
        {
          id: bundle.challenges[0]?.id,
          status: "failed",
          reason: "Observed wrong return type",
          evidence: ["C001"],
        },
      ],
    }),
  );
  expect(submitted.coverage[0]?.status).toBe("failed");
  expect(submitted.assessments[0]?.status).toBe("failed");
  const reread = value(await runProductReview(await workspace.state()));
  expect(reread.assessments[0]?.status).toBe("failed");
  expect(reread.findings[0]?.outcome).toBe("O001");
  expect(value(await runProductAccept(await workspace.state())).passed).toBe(false);
});

it("excludes stale coverage and keeps optional-only example failures out of required completion", () => {
  const brief = productBriefSchema.parse({
    version: 2,
    feature: "001-coverage",
    originalRequest: "A useful product",
    goal: "A useful product",
    outcomes: [
      { id: "O001", kind: "quality", statement: "Required", priority: "must" },
      { id: "O002", kind: "quality", statement: "Optional", priority: "could" },
    ],
    examples: [
      {
        id: "E001",
        title: "Required case",
        when: "act",
        expected: ["required result"],
        outcomes: ["O001"],
      },
      {
        id: "E002",
        title: "Optional case",
        when: "act",
        expected: ["optional result"],
        outcomes: ["O002"],
      },
    ],
  });
  const record: ProductRecord = {
    brief,
    briefText: "",
    stateText: "",
    state: initialProductState(brief, "2026-01-01"),
  };
  const challenges = productReviewChallenges(record);
  expect(challenges.map((entry) => entry.required)).toEqual([true, false]);
  const coverage = challenges.map((entry) => ({
    id: entry.id,
    status: entry.required ? ("satisfied" as const) : ("failed" as const),
    reason: "Observed",
    evidence: [],
  }));
  const assessments = brief.outcomes.map((entry) => ({
    outcome: entry.id,
    status: "satisfied" as const,
    summary: "Observed",
    evidence: [],
    expectations: [],
    provenance: "agent-reported" as const,
  }));
  const current = {
    policyVersion: PRODUCT_REVIEW_POLICY,
    subjectDigest: "current",
    contractDigest: productContractDigest(brief),
    createdAt: "2026-01-01",
    captures: [],
    assessments,
    coverage,
  };
  record.state.reviews.push(
    current,
    {
      ...current,
      subjectDigest: "old",
      coverage: coverage.map((entry) => ({ ...entry, status: "failed" })),
    },
    {
      ...current,
      contractDigest: "old-contract",
      coverage: coverage.map((entry) => ({ ...entry, status: "failed" })),
    },
  );
  expect(currentCoverage(record, "current")).toEqual(coverage);
  expect(
    finalProductAssessmentGaps(record, "current").filter(
      (gap) => gap.startsWith("EX-") || gap.startsWith("O"),
    ),
  ).toEqual([]);
  expect(finalProductAssessmentGaps(record, "current")).toEqual([]);
  expect(
    applyCoverageFailures(assessments, challenges, coverage).map((entry) => entry.status),
  ).toEqual(["satisfied", "failed"]);
});
