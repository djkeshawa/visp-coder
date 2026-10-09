import type { Result } from "../../../src/core/result.js";
import { runProductCritic } from "../../../src/workflow/product/critic.js";
import {
  createProductFeature,
  runProductAccept,
  runProductDone,
  runProductReview,
  runProductVerify,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { runProductUserFeedback } from "../../../src/workflow/product/user-feedback.js";
import { moduleFeedback } from "./product-feedback.js";
import { TestWorkspace } from "./workspace.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const node = process.execPath;
const test = (name: string, body: string) =>
  `import {test} from 'node:test'; import assert from 'node:assert/strict'; ${body}\ntest(${JSON.stringify(name)}, () => check());\n`;

/**
 * Two features recorded by the real workflow: one accepted, one mid-flight with
 * a closed slice, a failing check, open review findings and a pending question.
 * Every record is produced by the same services the CLI runs.
 */
export async function uiScenario(): Promise<{
  workspace: TestWorkspace;
  accepted: string;
  active: string;
}> {
  const workspace = await TestWorkspace.create({
    "src/total.mjs": "export const total = (rows) => rows.length;\n",
    "test/total.test.mjs": test(
      "total sums amounts",
      "import {total} from '../src/total.mjs'; const check = () => assert.equal(total([{amount: 2}, {amount: 3}]), 5);",
    ),
    "src/report.mjs": "export const header = () => 'name,amount';\n",
    "test/report.test.mjs": test(
      "report has a header",
      "import {header} from '../src/report.mjs'; const check = () => assert.equal(header(), 'name,amount');",
    ),
    "src/csv.mjs": "export const cell = (value) => String(value);\n",
    "test/csv.test.mjs": test(
      "cells with commas are quoted",
      "import {cell} from '../src/csv.mjs'; const check = () => assert.equal(cell('a,b'), '\"a,b\"');",
    ),
  });
  try {
    await workspace.installFoundation();
    workspace.commit("install foundation");
    const accepted = await acceptedFeature(workspace);
    const active = await activeFeature(workspace);
    return { workspace, accepted, active };
  } catch (error) {
    await workspace.destroy();
    throw error;
  }
}

async function acceptedFeature(workspace: TestWorkspace): Promise<string> {
  const created = value(
    await createProductFeature(await workspace.state(), {
      goal: "Sum report amounts",
      sourceBrief: "The report total should add up the amount column, not count rows.",
    }),
  );
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The total is the sum of the amount column",
            priority: "must",
            provenance: "user-stated",
            expectations: [{ id: "O001_AC1", statement: "Amounts 2 and 3 total 5" }],
          },
        ],
        checks: [
          {
            id: "C001",
            command: [node, "--test", "test/total.test.mjs"],
            outcomes: ["O001"],
            files: ["src/total.mjs", "test/total.test.mjs"],
            environment: "node",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Add up amounts",
            outcomes: ["O001"],
            scope: { allowed: ["src/total.mjs"], expected: ["src/total.mjs"], forbidden: [] },
            checks: ["C001"],
          },
        ],
      },
      reason: "Define the total",
    }),
  );
  const feature = created.brief.feature;
  value(await runProductWork(await workspace.state(), { feature }));
  value(await runProductDone(await workspace.state(), { feature }));
  await workspace.write(
    "src/total.mjs",
    "export const total = (rows) => rows.reduce((sum, row) => sum + row.amount, 0);\n",
  );
  value(await runProductDone(await workspace.state(), { feature }));
  const bundle = value(await runProductReview(await workspace.state(), { feature }));
  value(
    await runProductReview(await workspace.state(), {
      feature,
      subjectDigest: bundle.subjectDigest,
      feedback: moduleFeedback(bundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "The executed test sums two amounts to five.",
          evidence: ["C001"],
          expectations: [
            { id: "O001_AC1", status: "satisfied", reason: "Observed 5", evidence: ["C001"] },
          ],
        },
      ],
    }),
  );
  value(await runProductAccept(await workspace.state(), { feature }));
  workspace.commit("sum amounts");
  return feature;
}

async function activeFeature(workspace: TestWorkspace): Promise<string> {
  const created = value(
    await createProductFeature(await workspace.state(), {
      goal: "Export reports as CSV",
      sourceBrief:
        "Let people download the monthly report as a CSV file. It needs a header row, and values with commas or quotes must survive a round trip into a spreadsheet.",
    }),
  );
  const feature = created.brief.feature;
  value(
    await updateProductBrief(await workspace.state(), {
      brief: {
        ...created.brief,
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "The CSV starts with a header row",
            priority: "must",
            provenance: "user-stated",
          },
          {
            id: "O002",
            kind: "functional",
            statement: "Values containing commas or quotes are escaped",
            priority: "must",
            provenance: "user-stated",
            expectations: [{ id: "O002_AC1", statement: 'a,b becomes "a,b"' }],
          },
        ],
        decisions: [
          {
            id: "D001",
            statement: "Follow RFC 4180 quoting",
            rationale: "Spreadsheets read it without options",
          },
        ],
        uncertainties: ["Should the file name include the month?"],
        checks: [
          {
            id: "C001",
            command: [node, "--test", "test/report.test.mjs"],
            outcomes: ["O001"],
            files: ["src/report.mjs", "test/report.test.mjs"],
            environment: "node",
          },
          {
            id: "C002",
            command: [node, "--test", "test/csv.test.mjs"],
            outcomes: ["O002"],
            files: ["src/csv.mjs", "test/csv.test.mjs"],
            environment: "node",
          },
        ],
        slices: [
          {
            id: "T001",
            goal: "Write the header row",
            outcomes: ["O001"],
            scope: { allowed: ["src/report.mjs"], expected: ["src/report.mjs"], forbidden: [] },
            checks: ["C001"],
            approach: "Keep the column order in one place.",
          },
          {
            id: "T002",
            goal: "Escape cells the way spreadsheets expect",
            outcomes: ["O002"],
            dependsOn: ["T001"],
            scope: {
              allowed: ["src/csv.mjs", "test/csv.test.mjs"],
              expected: ["src/csv.mjs"],
              forbidden: ["src/report.mjs"],
            },
            checks: ["C002"],
            approach: "Quote any cell containing a comma, quote or newline; double inner quotes.",
          },
        ],
      },
      reason: "Plan the export",
    }),
  );
  value(await runProductWork(await workspace.state(), { feature, task: "T001" }));
  value(await runProductDone(await workspace.state(), { feature, task: "T001" }));
  value(await runProductWork(await workspace.state(), { feature, task: "T002" }));
  const failed = value(await runProductVerify(await workspace.state(), { feature, task: "T002" }))
    .executions[0];
  if (!failed) throw new Error("Missing failed execution");
  value(
    await runProductReview(await workspace.state(), {
      feature,
      task: "T002",
      subjectDigest: failed.subjectDigest,
      assessments: [],
      reviewer: { context: "fresh", model: "gpt-6-sol" },
      feedback: {
        phase: "product",
        summary: "Header output is right; cell escaping is not implemented yet.",
        dimensions: [
          {
            dimension: "fidelity",
            status: "satisfied",
            reason: "Outcomes cover both promises in the request.",
            evidence: [],
          },
          {
            dimension: "functional",
            status: "failed",
            reason: "A cell containing a comma is written unquoted.",
            evidence: [failed.id],
          },
        ],
        resolutions: [],
        findings: [
          {
            dimension: "functional",
            required: true,
            problem: "cell('a,b') returns a,b, which a spreadsheet splits into two columns.",
            nextCheck: "Rerun C002 after quoting cells that contain a comma.",
            outcomes: ["O002"],
            evidence: [failed.id],
          },
          {
            dimension: "functional",
            required: false,
            problem: 'Embedded quotes are not doubled, so He said "hi" would break the row.',
            nextCheck: "Add a C002 case for a value containing a double quote.",
            outcomes: ["O002"],
            evidence: [],
          },
        ],
      },
    }),
  );
  // Questions to the person are available once the project opts into manual review.
  const manual = await runProductCritic(await workspace.state(), {
    operation: "set-policy",
    mode: "manual",
  });
  if (!manual.ok) throw new Error(manual.error.message);
  const asked = await runProductUserFeedback(await workspace.state(), {
    feature,
    task: "T002",
    operation: "ask",
    question: "Should the file name include the month, like report-2026-09.csv?",
    context: "The download currently saves as report.csv.",
  });
  if (!asked.ok) throw new Error(asked.error.message);
  return feature;
}
