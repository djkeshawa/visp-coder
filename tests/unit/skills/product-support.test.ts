import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transitionSkill } from "../../../src/skills/lifecycle.js";
import { reconcileLineage } from "../../../src/skills/lineage.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { currentSupport, supportFor } from "../../../src/skills/support.js";
import {
  createProductFeature,
  runProductDone,
  runProductWork,
  updateProductBrief,
} from "../../../src/workflow/product/index.js";
import { productSkills } from "../../../src/workflow/product/skills.js";
import { readProductRecord } from "../../../src/workflow/product/store.js";
import { TestWorkspace } from "../support/workspace.js";

const SKILL = `---
name: product-review
description: Review the product behavior before extending it
appliesTo:
  paths: [src/**]
  stage: [implement]
---

## Procedure

Inspect the current behavior and its failure path before changing the implementation.
`;

let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create({ "src/app.mjs": "export const app = 0;\n" });
  await workspace.installFoundation();
  workspace.commit("install foundation");
});

afterEach(async () => {
  await workspace.destroy();
});

async function productSlice(goal: string): Promise<{ feature: string; task: string }> {
  const started = await createProductFeature(await workspace.state(), { goal });
  if (!started.ok) throw new Error(started.error.message);
  const feature = started.value.brief.feature;
  const updated = await updateProductBrief(await workspace.state(), {
    feature,
    brief: {
      ...started.value.brief,
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "The product exposes the promised behavior",
          provenance: "user-stated",
        },
      ],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "-e", "process.exit(0)"],
          outcomes: ["O001"],
          files: ["src/app.mjs"],
          environment: "node",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Deliver the promised behavior",
          outcomes: ["O001"],
          scope: { allowed: ["src/app.mjs"], expected: ["src/app.mjs"], forbidden: [] },
          checks: ["C001"],
        },
      ],
    },
    reason: "Define a current product slice",
  });
  if (!updated.ok) throw new Error(updated.error.message);
  const worked = await runProductWork(await workspace.state(), { feature, task: "T001" });
  if (!worked.ok) throw new Error(worked.error.message);
  const closed = await runProductDone(await workspace.state(), { feature, task: "T001" });
  if (!closed.ok) throw new Error(closed.error.message);
  return { feature, task: "T001" };
}

async function productSeries(): Promise<{ feature: string; tasks: string[] }> {
  const started = await createProductFeature(await workspace.state(), {
    goal: "Deliver an evolving public value",
  });
  if (!started.ok) throw new Error(started.error.message);
  const feature = started.value.brief.feature;
  const checks = [1, 2, 3, 4].map((value) => ({
    id: `C00${value}`,
    command: [
      process.execPath,
      "-e",
      `import('./src/app.mjs').then(({app}) => { if (app !== ${value}) process.exit(1); })`,
    ],
    outcomes: ["O001"],
    files: ["src/app.mjs"],
    environment: "node" as const,
  }));
  const updated = await updateProductBrief(await workspace.state(), {
    feature,
    brief: {
      ...started.value.brief,
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "The public value follows each delivered contract",
          provenance: "user-stated",
        },
      ],
      checks,
      slices: [1, 2, 3, 4].map((value) => ({
        id: `T00${value}`,
        goal: `Deliver value ${value}`,
        outcomes: ["O001"],
        scope: { allowed: ["src/app.mjs"], expected: ["src/app.mjs"], forbidden: [] },
        checks: [`C00${value}`],
      })),
    },
    reason: "Define the evolving product slices",
  });
  if (!updated.ok) throw new Error(updated.error.message);

  const tasks = ["T001", "T002", "T003", "T004"];
  for (const [index, task] of tasks.slice(0, 3).entries()) {
    const worked = await runProductWork(await workspace.state(), { feature, task });
    if (!worked.ok) throw new Error(worked.error.message);
    await workspace.write("src/app.mjs", `export const app = ${index + 1};\n`);
    const closed = await runProductDone(await workspace.state(), { feature, task });
    if (!closed.ok) throw new Error(closed.error.message);
  }
  return { feature, tasks };
}

describe("explicit proposals from current product support", () => {
  it("uses current product slices over retained legacy tasks without falling back for pending work", async () => {
    const series = await productSeries();
    await workspace.withFeature(
      series.feature,
      series.tasks.map((id) => ({ id, status: "done" })),
    );
    const support = await supportFor(await workspace.state(), series.feature, series.tasks);
    expect(support.closed).toEqual(["T001", "T002", "T003"]);
    expect(support.lost).toEqual(["T004"]);
    const legacy = await supportFor(
      await workspace.state(),
      series.feature,
      series.tasks,
      "legacy",
    );
    expect(legacy.closed).toEqual([]);
  });

  it.each(["removed", "altered"])(
    "invalidates a cited execution when its evidence is %s",
    async (change) => {
      const series = await productSeries();
      const state = await workspace.state();
      const proposed = await createProposalFromContent(
        state,
        {
          id: "execution-backed-review",
          sources: series.tasks.slice(0, 3).map((task) => ({ feature: series.feature, task })),
          origin: "derived",
        },
        SKILL,
      );
      if (!proposed.ok) throw new Error(proposed.error.message);
      const record = await readProductRecord(state, { feature: series.feature });
      if (!record.ok) throw new Error(record.error.message);
      const executions =
        change === "removed"
          ? record.value.state.executions.filter((entry) => entry.task !== "T001")
          : record.value.state.executions.map((entry) =>
              entry.task === "T001" ? { ...entry, output: "altered evidence" } : entry,
            );
      const written = await state.files.writeJson(
        state.paths.featureFile(series.feature, "product-state.json"),
        {
          ...record.value.state,
          executions,
        },
      );
      if (!written.ok) throw new Error(written.error.message);
      const current = await currentSupport(await workspace.state(), proposed.value);
      expect(current.lost).toContain(`${series.feature}/T001`);
      expect(current.closed).toHaveLength(2);
    },
  );

  it("keeps historical closed slices supported as later slices change, then selects for the next slice", async () => {
    const series = await productSeries();
    const state = await workspace.state();
    const sources = series.tasks.slice(0, 3).map((task) => ({ feature: series.feature, task }));
    const proposed = await createProposalFromContent(
      state,
      { id: "product-review", sources, by: "operator", origin: "derived" },
      SKILL,
    );

    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.state).toBe("proposed");
    expect(proposed.value.support).toHaveLength(3);

    const record = await readProductRecord(state, { feature: series.feature });
    if (!record.ok) throw new Error(record.error.message);
    const future = record.value.brief.slices.find((slice) => slice.id === "T004");
    if (!future) throw new Error("missing future product slice");
    const beforeAdmission = await productSkills(state, future);
    expect(beforeAdmission.ok && beforeAdmission.value.skills).toEqual([]);

    const admitted = await transitionSkill(state, "product-review", "admitted", {
      by: "reviewer",
    });
    expect(admitted.ok).toBe(true);
    const selected = await productSkills(state, future);
    expect(selected.ok && selected.value.skills.map((skill) => skill.path)).toEqual([
      ".visp/skills/product-review/SKILL.md",
    ]);
    const worked = await runProductWork(await workspace.state(), {
      feature: series.feature,
      task: "T004",
    });
    if (!worked.ok) throw new Error(worked.error.message);
    await workspace.write("src/app.mjs", "export const app = 4;\n");
    const delivered = await runProductDone(await workspace.state(), {
      feature: series.feature,
      task: "T004",
    });
    if (!delivered.ok) throw new Error(delivered.error.message);
    const retained = await productSkills(await workspace.state(), future);
    expect(retained.ok && retained.value.skills.map((skill) => skill.path)).toEqual([
      ".visp/skills/product-review/SKILL.md",
    ]);
    expect((await reconcileLineage(await workspace.state())).ok).toBe(true);
  });

  it("does not count the same product slice twice or accept a pending slice as support", async () => {
    const closed = await productSlice("Closed behavior");
    const duplicate = await createProposalFromContent(
      await workspace.state(),
      {
        id: "duplicate-product-review",
        sources: [closed, closed, closed],
        origin: "derived",
      },
      SKILL,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.message).toContain("closed task");

    const pendingStarted = await createProductFeature(await workspace.state(), {
      goal: "Pending behavior",
    });
    if (!pendingStarted.ok) throw new Error(pendingStarted.error.message);
    const pending = { feature: pendingStarted.value.brief.feature, task: "T001" };
    const mixed = await createProposalFromContent(
      await workspace.state(),
      {
        id: "pending-product-review",
        sources: [closed, pending, pending],
        origin: "derived",
      },
      SKILL,
    );
    expect(mixed.ok).toBe(false);
  });

  it("drops product support after a forged contract or an explicit reopen", async () => {
    const series = await productSeries();
    const state = await workspace.state();
    const record = await readProductRecord(state, { feature: series.feature });
    if (!record.ok) throw new Error(record.error.message);
    const stored = record.value.state.slices.T001;
    const previousClosure = record.value.state.sliceHistory.find((entry) => entry.task === "T001");
    if (!stored || !previousClosure) throw new Error("missing closure state");
    await state.files.writeJson(state.paths.featureFile(series.feature, "product-state.json"), {
      ...record.value.state,
      slices: { ...record.value.state.slices, T001: { ...stored, contractDigest: "forged" } },
    });
    const forged = await createProposalFromContent(
      await workspace.state(),
      {
        id: "forged-product-review",
        sources: series.tasks.slice(0, 3).map((task) => ({ feature: series.feature, task })),
        origin: "derived",
      },
      SKILL,
    );
    expect(forged.ok).toBe(false);

    await state.files.writeJson(
      state.paths.featureFile(series.feature, "product-state.json"),
      record.value.state,
    );
    workspace.commit("restore closure ledger");
    const freshState = await workspace.state();
    const freshRecord = await readProductRecord(freshState, { feature: series.feature });
    if (!freshRecord.ok) throw new Error(freshRecord.error.message);
    const freshStored = freshRecord.value.state.slices.T002;
    const freshClosure = freshRecord.value.state.sliceHistory.find(
      (entry) => entry.task === "T002",
    );
    if (!freshStored || !freshClosure) throw new Error("missing closure state");
    await freshState.files.writeJson(
      freshState.paths.featureFile(series.feature, "product-state.json"),
      {
        ...freshRecord.value.state,
        slices: {
          ...freshRecord.value.state.slices,
          T002: { ...freshStored, status: "in-progress" as const },
        },
        sliceHistory: [
          ...freshRecord.value.state.sliceHistory,
          {
            task: "T002",
            from: "closed",
            to: "in-progress",
            createdAt: new Date().toISOString(),
            subjectDigest: freshClosure.subjectDigest,
            reason: "Current product failure requires correction",
          },
        ],
      },
    );
    const reopened = await createProposalFromContent(
      freshState,
      {
        id: "reopened-product-review",
        sources: series.tasks.slice(0, 3).map((task) => ({ feature: series.feature, task })),
        origin: "derived",
      },
      SKILL,
    );
    expect(reopened.ok).toBe(false);
  });

  it("binds a matching pre-closure review into support lineage", async () => {
    const series = await productSeries();
    const state = await workspace.state();
    const record = await readProductRecord(state, { feature: series.feature });
    if (!record.ok) throw new Error(record.error.message);
    const closure = record.value.state.sliceHistory.find((entry) => entry.task === "T001");
    const contractDigest = record.value.state.slices.T001?.contractDigest;
    if (!closure || !contractDigest) throw new Error("missing product support evidence");
    const review = {
      policyVersion: 5 as const,
      subjectDigest: closure.subjectDigest,
      contractDigest,
      task: "T001",
      createdAt: new Date(Date.parse(closure.createdAt) - 1).toISOString(),
      assessments: [{ outcome: "O001", status: "satisfied" as const, summary: "Reviewed" }],
      reviewer: { context: "current" as const },
      captures: [],
    };
    await state.files.writeJson(state.paths.featureFile(series.feature, "product-state.json"), {
      ...record.value.state,
      reviews: [...record.value.state.reviews, review],
    });

    const proposed = await createProposalFromContent(
      await workspace.state(),
      {
        id: "review-backed-product-review",
        sources: series.tasks.slice(0, 3).map((task) => ({ feature: series.feature, task })),
        origin: "derived",
      },
      SKILL,
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.support?.find((source) => source.task === "T001")?.reviewHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    const after = await workspace.state();
    const afterRecord = await readProductRecord(after, { feature: series.feature });
    if (!afterRecord.ok) throw new Error(afterRecord.error.message);
    await after.files.writeJson(after.paths.featureFile(series.feature, "product-state.json"), {
      ...afterRecord.value.state,
      reviews: [],
    });
    const current = await currentSupport(await workspace.state(), proposed.value);
    expect(current.lost).toContain(`${series.feature}/T001`);
  });
});
