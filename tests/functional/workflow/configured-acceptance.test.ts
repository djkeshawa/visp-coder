import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { ProductBrief, ProductExecution } from "../../../src/workflow/product/model.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { succeeded } from "../support/product.js";
import { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it("pins configured acceptance at feature creation and refuses config removal or changed assertions as substitutes for repair", async () => {
  const expectation =
    "import assert from 'node:assert/strict'; import {stable} from '../src/value.mjs'; assert.equal(stable,true);\n";
  project = await TestProject.create({
    "src/value.mjs": "export const value=1; export const stable=false;\n",
    "tests/value.mjs":
      "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
    "tests/expectation.mjs": expectation,
  });
  succeeded(project, "init", "--harness", "generic");
  const settings = parse(await project.read("visp.yml"));
  settings.critic = { ...settings.critic, enabled: false };
  settings.workflow.acceptanceChecks = [
    { command: [process.execPath, "tests/expectation.mjs"], files: ["tests/expectation.mjs"] },
  ];
  const configured = stringify(settings);
  await project.write("visp.yml", configured);
  succeeded(project, "install", "--hooks", "git");
  project.commit("install configured acceptance");
  const created = project.json<{ brief: ProductBrief }>(
    "feature",
    "Return two and preserve stable behavior",
  );
  expect(created.result.exitCode, created.result.stdout).toBe(0);
  const brief = created.envelope.data?.brief;
  if (!brief) throw new Error("Missing feature");
  expect(brief.acceptanceBaseline).toHaveLength(1);
  expect(brief.acceptanceBaseline[0]?.files[0]).toMatchObject({
    path: "tests/expectation.mjs",
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  await project.authorBrief(brief.feature, {
    outcomes: [
      {
        id: "O001",
        kind: "functional",
        statement: "The public value is two and stable behavior remains available",
        priority: "must",
      },
    ],
    checks: [
      {
        id: "C001",
        command: [process.execPath, "tests/value.mjs"],
        files: ["src/value.mjs", "tests/value.mjs"],
        verifierFiles: ["tests/value.mjs"],
        outcomes: ["O001"],
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Return two",
        outcomes: ["O001"],
        checks: ["C001"],
        scope: { allowed: ["src/**", "tests/**"], expected: ["src/value.mjs"] },
      },
    ],
  });
  succeeded(project, "work");
  await project.write("src/value.mjs", "export const value=2; export const stable=false;\n");
  // The last open slice completes the product, so its `done` already runs the pinned check.
  const open = project.json<{ closed: boolean; executions: ProductExecution[] }>("done");
  expect(open.envelope.data?.closed, open.result.stdout).toBe(false);
  expect(open.envelope.data?.executions).toEqual(
    expect.arrayContaining([expect.objectContaining({ check: "PINNED_1", status: "failed" })]),
  );
  await project.write("src/value.mjs", "export const value=2; export const stable=true;\n");
  const closed = project.json<{ closed: boolean }>("done");
  expect(closed.envelope.data?.closed, closed.result.stdout).toBe(true);
  // A regression after closure must still fail acceptance, however the worker reacts.
  await project.write("src/value.mjs", "export const value=2; export const stable=false;\n");
  const activeProject = project;
  const acceptance = () =>
    activeProject.json<{ passed: boolean; executions: ProductExecution[]; gaps: string[] }>(
      "accept",
    );
  const failed = acceptance();
  expect(failed.envelope.data?.passed, failed.result.stdout).toBe(false);
  expect(failed.envelope.data?.executions).toEqual(
    expect.arrayContaining([expect.objectContaining({ check: "PINNED_1", status: "failed" })]),
  );
  await project.write(
    "visp.yml",
    stringify({ ...settings, workflow: { ...settings.workflow, acceptanceChecks: [] } }),
  );
  const removed = acceptance();
  expect(removed.envelope.data?.executions).toEqual(
    expect.arrayContaining([expect.objectContaining({ check: "PINNED_1", status: "failed" })]),
  );
  expect(removed.envelope.data?.passed).toBe(false);
  await project.write("visp.yml", configured);
  await project.write("tests/expectation.mjs", "// weakened check must not earn acceptance\n");
  const weakened = acceptance();
  expect(weakened.envelope.data?.passed, weakened.result.stdout).toBe(false);
  expect(weakened.envelope.data?.gaps.join("\n")).toContain("Pinned expectation changed");
  await project.write("tests/expectation.mjs", expectation);
  const reopened = project.json<{ checks: Array<{ id: string }> }>("work", "--task", "T001");
  expect(reopened.result.exitCode, reopened.result.stdout).toBe(0);
  expect(reopened.envelope.data?.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "PINNED_1" })]),
  );
  await project.write("src/value.mjs", "export const value=2; export const stable=true;\n");
  const repaired = project.json<{ closed: boolean; executions: ProductExecution[] }>(
    "done",
    "--task",
    "T001",
  );
  // This source already passed at the first closure, so `done` reuses those executions.
  expect(repaired.envelope.data?.closed, repaired.result.stdout).toBe(true);
  const exercised = acceptance();
  expect(exercised.envelope.data?.executions).toEqual(
    expect.arrayContaining([expect.objectContaining({ check: "PINNED_1", status: "passed" })]),
  );
  const review = project.json<ProductReviewBundle>("review");
  const bundle = review.envelope.data;
  if (!bundle) throw new Error(review.result.stdout);
  await project.write(
    ".visp/drafts/assessment.json",
    JSON.stringify({
      subjectDigest: bundle.subjectDigest,
      reviewer: { context: "current" },
      feedback: moduleFeedback(bundle),
      assessments: [
        {
          outcome: "O001",
          status: "satisfied",
          summary: "Both declared behavior and unchanged pinned expectation executed successfully",
          evidence: ["C001", "PINNED_1"],
        },
      ],
    }),
  );
  succeeded(project, "review", "--from", ".visp/drafts/assessment.json");
  const accepted = acceptance();
  expect(accepted.envelope.data?.passed, accepted.result.stdout).toBe(true);
  const stored = parse(
    await project.read(`.visp/features/${brief.feature}/brief.yaml`),
  ) as ProductBrief;
  expect(stored.acceptanceBaseline).toEqual(brief.acceptanceBaseline);
});
