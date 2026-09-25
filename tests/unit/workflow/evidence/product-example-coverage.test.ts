import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Result } from "../../../../src/core/result.js";
import { productReviewChallenges } from "../../../../src/workflow/product/coverage.js";
import {
  runProductAccept,
  runProductDone,
  runProductNext,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { productReviewerHandoff } from "../../../../src/workflow/product/reviewer-handoff.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productInputTemplate } from "../../../../src/workflow/product-inputs.js";
import { productReviewReceipt } from "../../../../src/workflow/product-presentation.js";
import { moduleFeedback } from "../../support/product-feedback.js";
import { productWorkspace } from "../../support/product-workspace.js";

let project: Awaited<ReturnType<typeof productWorkspace>>;
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
beforeEach(async () => {
  project = await productWorkspace();
});
afterEach(async () => {
  await project.workspace.destroy();
});

async function ready() {
  project.brief = value(
    await updateProductBrief(await project.workspace.state(), {
      brief: {
        ...project.brief,
        examples: [
          {
            id: "E001",
            title: "Numeric conversion",
            given: ["A caller supplies text"],
            when: "getValue('2') is called",
            expected: ["The result is a number", "The result equals two"],
            outcomes: ["O001"],
          },
        ],
      },
      intentChange: { reason: "Retain the concrete input behavior", provenance: "test oracle" },
    }),
  );
  value(await runProductWork(await project.workspace.state()));
  await project.workspace.write(
    "src/value.mjs",
    "export const value = 2; export const getValue = input => input;\n",
  );
  expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
  return value(await runProductReview(await project.workspace.state()));
}

describe("retained example coverage", () => {
  it("retains behavior examples and blocks an independently reported defect despite a passing weak check", async () => {
    const bundle = await ready();
    const reviewed = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "failed",
            summary:
              "Independent inspection found getValue returns a string; the public-value test does not check conversion",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(reviewed.challenges).toHaveLength(2);
    expect(reviewed.challenges[0]).toMatchObject({
      given: ["A caller supplies text"],
      when: "getValue('2') is called",
    });
    const accepted = value(await runProductAccept(await project.workspace.state()));
    expect(accepted.passed).toBe(false);
    expect(accepted.gaps).toEqual(expect.arrayContaining([expect.stringContaining("O001")]));
    expect(value(await runProductNext(await project.workspace.state())).action).toBe("fix");
  });

  it("retains observed failures when a later submission omits them", async () => {
    const bundle = await ready();
    const failed = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The basic case passes",
            evidence: ["C001"],
          },
        ],
        coverage: [
          {
            id: bundle.challenges[0]?.id,
            status: "failed",
            reason: "getValue returns the input string without conversion",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(failed.assessments[0]?.status).toBe("failed");
    const repeated = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "No change to product, only a different description",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(repeated.assessments[0]?.status).toBe("failed");
    expect(repeated.refinement.used).toBe(0);
    const unchangedFailure = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [],
        coverage: [
          {
            id: bundle.challenges[0]?.id,
            status: "failed",
            reason: "The same conversion still returns text; rewriting the summary did not fix it",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(unchangedFailure.recurrence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: bundle.challenges[0]?.id,
          attempts: 2,
          recovery: expect.stringContaining("different hypothesis"),
        }),
      ]),
    );
    expect(productReviewReceipt(unchangedFailure).recurrence).toEqual(unchangedFailure.recurrence);
    expect(productReviewerHandoff(unchangedFailure).recurrence).toEqual(
      unchangedFailure.recurrence,
    );
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(false);
  });

  it("accepts a legitimate indirect helper with actual execution, without test-syntax heuristics", async () => {
    const initial = await ready();
    value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: initial.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "failed",
            summary: "getValue('2') returns text instead of the promised number",
            evidence: ["C001"],
          },
        ],
      }),
    );
    value(await runProductWork(await project.workspace.state(), { task: "T001" }));
    await project.workspace.write(
      "src/value.mjs",
      "export const value = 2; export const getValue = input => Number(input);\n",
    );
    await project.workspace.write(
      "test/value.test.mjs",
      "import { getValue } from '../src/value.mjs'; const evaluate = fn => { const result = fn('2'); if (typeof result !== 'number' || result !== 2) throw Error('conversion failed'); }; evaluate(getValue); console.log('helper observed number 2');\n",
    );
    value(await runProductDone(await project.workspace.state()));
    const bundle = value(await runProductReview(await project.workspace.state()));
    expect(bundle.executions.at(-1)?.output).toContain("helper observed number 2");
    value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback: moduleFeedback(bundle),
        reviewer: { context: "current", reason: "Host has no separate reviewer context" },
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The helper executed conversion with numeric-text input",
            evidence: ["C001"],
          },
        ],
        coverage: bundle.challenges.map((challenge) => ({
          id: challenge.id,
          status: "satisfied",
          reason:
            "The executed helper observed numeric 2 and would throw for the original string-returning implementation",
          evidence: ["C001"],
        })),
      }),
    );
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });

  it("generates unresolved templates, rejects invented coverage IDs and source-only support", async () => {
    const bundle = await ready();
    const template = value(await productInputTemplate(await project.workspace.state(), "review"));
    expect(template).toMatchObject({
      reviewer: { context: "unspecified" },
      coverage: [],
    });
    const bad = await runProductReview(await project.workspace.state(), {
      subjectDigest: bundle.subjectDigest,
      assessments: [],
      coverage: [{ id: "invented", status: "satisfied", reason: "Looks good", evidence: ["C001"] }],
    });
    expect(bad.ok).toBe(false);
    const unsupported = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [],
        coverage: [
          {
            id: bundle.challenges[0]?.id,
            status: "satisfied",
            reason: "The request asks for conversion",
            evidence: ["SRC-REQUEST"],
          },
        ],
      }),
    );
    expect(unsupported.coverage[0]?.status).toBe("unavailable");
  });

  it("keeps challenge identity stable across metadata edits and changes it with the behavioral input", async () => {
    await ready();
    const record = value(await readProductRecord(await project.workspace.state()));
    const before = productReviewChallenges(record);
    const metadata = structuredClone(record);
    const example = metadata.brief.examples[0];
    if (!example) throw new Error("Missing example");
    example.title = "A clearer name";
    example.expected.reverse();
    expect(
      productReviewChallenges(metadata)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(before.map((entry) => entry.id).sort());
    example.when = "getValue('3') is called";
    expect(productReviewChallenges(metadata)[0]?.id).not.toBe(before[0]?.id);
  });

  it("prepares an unbiased fresh-context handoff and compact mutation receipt without claiming independence", async () => {
    const bundle = await ready();
    const reviewed = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        reviewer: { context: "unavailable", reason: "Host cannot inspect images" },
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The implementer likes it",
            evidence: ["C001"],
          },
        ],
      }),
    );
    expect(reviewed.assessments[0]?.status).toBe("unavailable");
    const handoff = productReviewerHandoff(reviewed);
    expect(handoff.dispatch).toMatchObject({ owner: "host", context: "fresh-preferred" });
    expect(handoff.dispatch.model).toContain("configured model");
    expect(handoff).not.toHaveProperty("assessments");
    const receipt = productReviewReceipt(reviewed);
    expect(receipt.recorded).toBe(true);
    expect(receipt).not.toHaveProperty("captureRuns");
    expect(receipt).not.toHaveProperty("images");
    expect(receipt.unresolved).toHaveLength(3);
  });
});
