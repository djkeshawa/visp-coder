import { afterEach, expect, it } from "vitest";
import type { SkillRecord } from "../../../src/skills/schema.js";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import type { ProductState } from "../../../src/workflow/product/model.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";
import { syntheticSkillEvaluation } from "../support/skill-evaluation.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it.each(["execution", "review"] as const)(
  "invalidates admitted learning when supporting %s evidence changes after rollback",
  async (supportKind) => {
    const values = [1, 2, 3, 4];
    const created = await productProject({
      files: {
        "src/value.mjs": "export const value = 0;\n",
        ...Object.fromEntries(
          values.map((value) => [
            `tests/value-${value}.mjs`,
            `import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value, ${value});\n`,
          ]),
        ),
      },
      definition: {
        outcomes: [
          {
            id: "O001",
            kind: "functional",
            statement: "Each slice delivers its promised public value",
            provenance: "user-stated",
          },
        ],
        checks: values.map((value) => ({
          id: `C00${value}`,
          command: [process.execPath, `tests/value-${value}.mjs`],
          verifierFiles: [`tests/value-${value}.mjs`],
          outcomes: ["O001"],
          files: ["src/value.mjs", `tests/value-${value}.mjs`],
          environment: "node",
        })),
        slices: values.map((value) => ({
          id: `T00${value}`,
          goal: `Deliver public value ${value}`,
          outcomes: ["O001"],
          checks: [`C00${value}`],
          scope: { allowed: ["src/value.mjs"], expected: ["src/value.mjs"], forbidden: [] },
        })),
      },
    });
    project = created.project;
    const { feature } = created;
    for (const value of values.slice(0, 3)) {
      const selection = ["--feature", feature, "--task", `T00${value}`];
      succeeded(project, "work", ...selection);
      const failed = project.run("verify", ...selection);
      expect(failed.exitCode).not.toBe(0);
      if (supportKind === "review") await reportFailure(project, selection);
      await project.write("src/value.mjs", `export const value = ${value};\n`);
      if (supportKind === "review") {
        succeeded(project, "verify", ...selection);
        await assessRepair(project, selection);
      }
      succeeded(project, "done", ...selection);
    }
    const statePath = `.visp/features/${feature}/product-state.json`;
    const history: ProductState = JSON.parse(await project.read(statePath));
    for (const value of values.slice(0, 3)) {
      expect(
        history.executions
          .filter((entry) => entry.task === `T00${value}`)
          .map((entry) => entry.status),
      ).toEqual(["failed", "passed"]);
    }
    const procedure = "Check the public value with an executable assertion before closing a slice.";
    await project.write(
      "learned.md",
      `---\nname: verified-value\nappliesTo:\n  paths: [src/**]\n  stage: [implement]\n---\n\n## Procedure\n\n${procedure}\n`,
    );
    const proposed = project.json<SkillRecord>(
      "skill",
      "propose",
      "--id",
      "verified-value",
      "--file",
      "learned.md",
      "--feature",
      feature,
      "--from-task",
      "T001",
      "T002",
      "T003",
    );
    expect(proposed.result.exitCode, proposed.result.stdout).toBe(0);
    expect(proposed.envelope.data).toMatchObject({ state: "proposed", origin: "derived" });
    expect(proposed.envelope.data?.support).toHaveLength(3);
    if (supportKind === "review")
      expect(proposed.envelope.data?.support?.every((entry) => !!entry.reviewHash)).toBe(true);
    const context = () => {
      const result = created.project.json<ProductWorkContext>(
        "work",
        "--feature",
        feature,
        "--task",
        "T004",
      );
      expect(result.result.exitCode, result.result.stdout).toBe(0);
      if (!result.envelope.data) throw new Error("Missing context");
      return result.envelope.data;
    };
    expect(context().skills).toEqual([]);
    const admitted =
      supportKind === "review"
        ? await evaluateDerivedRevision(project, proposed.envelope.data?.version)
        : project.json<SkillRecord>("skill", "admit", "verified-value", "--by", "fixture-reviewer");
    expect(admitted.result.exitCode, admitted.result.stdout).toBe(0);
    const version = admitted.envelope.data?.version;
    if (!version) throw new Error("Missing admitted version");
    expect(context().skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining(procedure), advisory: true }),
      ]),
    );
    succeeded(
      project,
      "skill",
      "retire",
      "verified-value",
      "--reason",
      "Check an explicit rollback",
    );
    expect(context().skills).toEqual([]);
    succeeded(
      project,
      "skill",
      "rollback",
      "verified-value",
      "--revision",
      version,
      "--by",
      "fixture-reviewer",
      "--reason",
      "Restore reviewed procedure with intact support",
    );
    const restored = context();
    expect(
      restored.skills.some((entry) => entry.content.includes(procedure)),
      JSON.stringify({ skills: restored.skills, notes: restored.notes, budget: restored.budget }),
    ).toBe(true);
    const changed: ProductState = JSON.parse(await project.read(statePath));
    const support = changed.executions.find(
      (entry) => entry.task === "T001" && entry.status === "passed",
    );
    if (!support) throw new Error("Missing supporting execution");
    if (supportKind === "execution") support.output = "Evidence altered after admission";
    else {
      const resolution = changed.reviews.find(
        (entry) => entry.task === "T001" && entry.feedback?.resolutions.length,
      )?.feedback?.resolutions[0];
      if (!resolution) throw new Error("Missing supporting repair assessment");
      resolution.explanation = "Review evidence altered after admission";
    }
    await project.write(statePath, JSON.stringify(changed));
    const unsupported = context();
    expect(unsupported.skills).toEqual([]);
    expect(unsupported.notes.join("\n")).toContain("verified-value: learning support changed");
    expect(unsupported.notes.join("\n")).toContain("visp skill show verified-value");
    const refused = project.run(
      "skill",
      "rollback",
      "verified-value",
      "--revision",
      version,
      "--by",
      "fixture-reviewer",
      "--reason",
      "Attempt restoration after evidence changed",
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(/support|closed task/i);
  },
  // Three repaired slices plus separate CLI review/admission/rollback processes share suite resources.
  60_000,
);

async function submitFeedback(project: TestProject, selection: string[], value: unknown) {
  await project.write(".visp/drafts/learning-review.json", JSON.stringify(value));
  succeeded(project, "review", ...selection, "--from", ".visp/drafts/learning-review.json");
}

async function reportFailure(project: TestProject, selection: string[]) {
  const bundle: ProductReviewBundle = JSON.parse(succeeded(project, "review", ...selection));
  const failed = bundle.executions.find((entry) => entry.status === "failed");
  if (!failed) throw new Error("Missing executed failure");
  await submitFeedback(project, selection, {
    subjectDigest: bundle.subjectDigest,
    reviewer: { context: "current" },
    assessments: [],
    feedback: {
      phase: "product",
      dimensions: [],
      resolutions: [],
      findings: [
        {
          dimension: "functional",
          required: true,
          problem: "The exported value does not match this slice's promised result",
          nextCheck: "Repair the export and rerun the unchanged verifier",
          outcomes: ["O001"],
          evidence: [failed.id],
        },
      ],
    },
  });
}

async function assessRepair(project: TestProject, selection: string[]) {
  const bundle: ProductReviewBundle = JSON.parse(succeeded(project, "review", ...selection));
  const finding = bundle.feedbackPlan.findings[0];
  const passed = bundle.executions.find((entry) => entry.status === "passed");
  if (!finding || !passed) throw new Error("Missing finding or passing repair execution");
  await submitFeedback(project, selection, {
    subjectDigest: bundle.subjectDigest,
    reviewer: { context: "current" },
    assessments: [
      {
        outcome: "O001",
        status: "satisfied",
        summary:
          "The unchanged verifier passes for the promised public value after the export was repaired",
        evidence: [passed.id],
      },
    ],
    feedback: {
      ...moduleFeedback(bundle),
      resolutions: [
        {
          id: finding.id,
          explanation: "The same assertion failed before the repair and passes on this subject",
          evidence: [passed.id],
          regression: {
            kind: "not-applicable",
            explanation:
              "This constant export has no other operation or mutable lifecycle; the verifier asserts the complete promised value",
          },
        },
      ],
    },
  });
}

/** Operator-supplied synthetic evaluation qualifies lifecycle wiring, not empirical benefit. */
async function evaluateDerivedRevision(project: TestProject, version: string | undefined) {
  if (!version) throw new Error("Missing derived revision");
  const id = "verified-value";
  await project.write(
    ".visp/drafts/derived-evaluation.json",
    JSON.stringify(syntheticSkillEvaluation(version)),
  );
  const evaluated = project.json<{ id: string; skill: SkillRecord }>(
    "skill",
    "evaluate",
    id,
    "--file",
    ".visp/drafts/derived-evaluation.json",
    "--by",
    "fixture-reviewer",
  );
  expect(evaluated.result.exitCode, evaluated.result.stdout).toBe(0);
  const recorded = evaluated.envelope.data;
  if (!recorded) throw new Error("Missing derived evaluation");
  expect(recorded.skill).toMatchObject({
    origin: "derived",
    state: "proposed",
    version,
    evidence: { usefulnessBasis: "operator-reviewed-claim" },
  });
  expect(recorded.skill.support?.every((entry) => !!entry.reviewHash)).toBe(true);
  const promoted = project.json<SkillRecord>(
    "skill",
    "promote",
    id,
    "--evaluation",
    recorded.id,
    "--by",
    "fixture-reviewer",
  );
  expect(promoted.result.exitCode, promoted.result.stdout).toBe(0);
  expect(promoted.envelope.data).toMatchObject({ origin: "derived", state: "admitted", version });
  expect(promoted.envelope.data?.support).toEqual(recorded.skill.support);
  return promoted;
}
