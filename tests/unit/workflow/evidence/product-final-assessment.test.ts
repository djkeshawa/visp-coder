import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../../../src/core/exec.js";
import type { Result } from "../../../../src/core/result.js";
import {
  runProductAccept,
  runProductDone,
  runProductReview,
  runProductWork,
  updateProductBrief,
} from "../../../../src/workflow/product/index.js";
import { productStatePath } from "../../../../src/workflow/product/store.js";
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

async function closePassingSlice() {
  value(await runProductWork(await project.workspace.state()));
  await project.workspace.write("src/value.mjs", "export const value = 2;\n");
  expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
}
async function assess(assessment: Record<string, unknown>) {
  const bundle = value(await runProductReview(await project.workspace.state()));
  return runProductReview(await project.workspace.state(), {
    subjectDigest: bundle.subjectDigest,
    feedback: moduleFeedback(bundle),
    assessments: [
      { outcome: "O001", summary: "Observed public behavior", evidence: ["C001"], ...assessment },
    ],
  });
}
async function addIndependentExpectations() {
  project.brief = value(
    await updateProductBrief(await project.workspace.state(), {
      brief: {
        ...project.brief,
        outcomes: project.brief.outcomes.map((outcome) => ({
          ...outcome,
          expectations: [
            {
              id: "E001",
              statement: "Numeric text is returned as a number",
              provenance: "independent",
            },
          ],
        })),
      },
      intentChange: {
        reason: "Test oracle supplies a required input example",
        provenance: "independent test fixture",
      },
    }),
  );
}

describe("final product assessment", () => {
  it("explains how to record behavior when an external test is not mapped to the outcome", async () => {
    project.brief = value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          checks: project.brief.checks.map((check) => ({ ...check, outcomes: [] })),
        },
        reason: "Exercise an unmapped external check",
      }),
    );
    value(await runProductWork(await project.workspace.state()));
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = value(await runProductDone(await project.workspace.state()));
    expect(done.closed).toBe(false);
    expect(done.gaps).toContainEqual(expect.stringContaining("no mapped behavior check"));
    expect(done.gaps).toContainEqual(expect.stringContaining("slice.checks"));
    expect(done.executions[0]?.status).toBe("passed");
  });

  it("does not treat a syntax-only check as functional evidence or final acceptance", async () => {
    project.brief = value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          checks: [
            {
              ...project.brief.checks[0],
              command: [process.execPath, "--check", "src/value.mjs"],
            },
          ],
        },
        reason: "Exercise the syntax-only regression boundary",
      }),
    );
    value(await runProductWork(await project.workspace.state()));
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    const done = value(await runProductDone(await project.workspace.state()));
    expect(done.closed).toBe(false);
    expect(done.gaps).toContain("O001: behavior unassessed; review unassessed");

    const bundle = value(await runProductReview(await project.workspace.state()));
    const reviewed = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The syntax check passed",
            evidence: ["C001"],
          },
        ],
        coverage: bundle.challenges.map((challenge) => ({
          id: challenge.id,
          status: "satisfied" as const,
          reason: "The syntax check passed",
          evidence: ["C001"],
        })),
      }),
    );
    expect(reviewed.assessments[0]?.status).toBe("unavailable");
    expect(await runProductAccept(await project.workspace.state())).toMatchObject({
      ok: false,
      error: { message: "Close the active slices before final product acceptance" },
    });
  });

  it("allows behavioral slice closure but requires explicit goal judgment before acceptance", async () => {
    await closePassingSlice();
    expect(value(await runProductAccept(await project.workspace.state()))).toMatchObject({
      passed: false,
      gaps: expect.arrayContaining([expect.stringContaining("final goal assessment unassessed")]),
    });
    const reviewed = value(
      await assess({
        status: "satisfied",
        summary: "The actual exported value is the requested number two",
      }),
    );
    expect(reviewed.assessments[0]).toMatchObject({
      provenance: "agent-reported",
      expectations: [],
    });
    expect(reviewed.images).toEqual([]);
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });

  it("honors an explicit functional review requirement without requiring an image", async () => {
    project.brief = value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          outcomes: project.brief.outcomes.map((outcome) => ({ ...outcome, reviewRequired: true })),
        },
        intentChange: {
          reason: "Require assessment of the public behavior",
          provenance: "test fixture",
        },
      }),
    );
    value(await runProductWork(await project.workspace.state()));
    await project.workspace.write("src/value.mjs", "export const value = 2;\n");
    expect(value(await runProductDone(await project.workspace.state())).closed).toBe(false);
    const reviewed = value(
      await assess({
        status: "satisfied",
        summary: "The executed public-module test returned number two",
      }),
    );
    expect(reviewed.images).toEqual([]);
    expect(reviewed.assessments[0]?.status).toBe("satisfied");
    expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });

  it("keeps an independently observed failure visible despite a passing weak check", async () => {
    await addIndependentExpectations();
    value(await runProductWork(await project.workspace.state()));
    await project.workspace.write(
      "src/value.mjs",
      "export const value = 2; export const getValue = input => input;\n",
    );
    expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
    const observed = value(
      await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {getValue} from './src/value.mjs'; console.log(typeof getValue('2'));",
        ],
        { cwd: project.workspace.root },
      ),
    );
    expect(observed.stdout.trim()).toBe("string");
    value(
      await assess({
        status: "satisfied",
        summary: "The default export value meets the ordinary case",
      }),
    );
    expect(value(await runProductAccept(await project.workspace.state())).gaps).toContain(
      "O001.E001: mandatory expectation (reported source: independent) unassessed: Numeric text is returned as a number",
    );
    value(
      await assess({
        status: "satisfied",
        expectations: [
          {
            id: "E001",
            status: "failed",
            reason: "Executing getValue('2') returned a string instead of a number",
          },
        ],
      }),
    );
    expect(value(await runProductAccept(await project.workspace.state()))).toMatchObject({
      passed: false,
      gaps: expect.arrayContaining([
        expect.stringContaining("mandatory expectation (reported source: independent) failed"),
      ]),
    });
  });

  it.each(["unclear", "unavailable"] as const)(
    "does not turn an %s independent expectation into a pass",
    async (status) => {
      await addIndependentExpectations();
      await closePassingSlice();
      value(
        await assess({
          status: "satisfied",
          expectations: [
            { id: "E001", status, reason: "The independent case could not be assessed" },
          ],
        }),
      );
      expect(value(await runProductAccept(await project.workspace.state()))).toMatchObject({
        passed: false,
        gaps: expect.arrayContaining([
          expect.stringContaining(`mandatory expectation (reported source: independent) ${status}`),
        ]),
      });
    },
  );

  it("accepts assessed independent expectations without requiring screenshots for functional work", async () => {
    await addIndependentExpectations();
    value(await runProductWork(await project.workspace.state()));
    await project.workspace.write(
      "src/value.mjs",
      "export const value = 2; export const getValue = input => Number(input);\n",
    );
    await project.workspace.write(
      "test/value.test.mjs",
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value,getValue} from '../src/value.mjs'; test('the promised value',()=>assert.equal(value,2)); test('numeric text',()=>assert.equal(getValue('2'),2));\n",
    );
    expect(value(await runProductDone(await project.workspace.state())).closed).toBe(true);
    const observed = value(
      await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "import {getValue} from './src/value.mjs'; console.log(typeof getValue('2'));",
        ],
        { cwd: project.workspace.root },
      ),
    );
    expect(observed.stdout.trim()).toBe("number");
    value(
      await assess({
        status: "satisfied",
        summary: "The public value is two and numeric text produces a number",
        expectations: [
          { id: "E001", status: "satisfied", reason: "Executing getValue('2') returned a number" },
        ],
      }),
    );
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });

  it.each([
    {
      name: "unknown ID",
      expectations: [{ id: "E404", status: "satisfied", reason: "Unknown" }],
      message: "distinct expectations",
    },
    {
      name: "duplicate ID",
      expectations: [
        { id: "E001", status: "satisfied", reason: "First" },
        { id: "E001", status: "satisfied", reason: "Duplicate" },
      ],
      message: "distinct expectations",
    },
    {
      name: "blank reason",
      expectations: [{ id: "E001", status: "satisfied", reason: " " }],
      message: "Invalid assessments",
    },
  ])("rejects $name claims before changing evidence", async ({ expectations, message }) => {
    await addIndependentExpectations();
    await closePassingSlice();
    const state = await project.workspace.state();
    const path = productStatePath(state, project.brief.feature);
    const before = await readFile(path, "utf8");
    const result = await assess({ status: "satisfied", expectations });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID", message: expect.stringContaining(message) },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not let optional findings consume required refinement cycles", async () => {
    project.brief = value(
      await updateProductBrief(await project.workspace.state(), {
        brief: {
          ...project.brief,
          outcomes: [
            ...project.brief.outcomes,
            {
              id: "O002",
              kind: "quality",
              priority: "could",
              statement: "Optional naming preference",
            },
          ],
        },
        reason: "Track a nonblocking style suggestion",
      }),
    );
    await closePassingSlice();
    const bundle = value(await runProductReview(await project.workspace.state()));
    const reviewed = value(
      await runProductReview(await project.workspace.state(), {
        subjectDigest: bundle.subjectDigest,
        feedback: moduleFeedback(bundle),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "The public value is two",
            evidence: ["C001"],
          },
          { outcome: "O002", status: "failed", summary: "Another name might read better" },
        ],
      }),
    );
    expect(reviewed.refinement).toMatchObject({ used: 0, remaining: 2, exhausted: false });
    expect(value(await runProductAccept(await project.workspace.state())).passed).toBe(true);
  });
});
