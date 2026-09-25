import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Result } from "../../../src/core/result.js";
import { capabilityUtilization } from "../../../src/telemetry/capabilities.js";
import {
  runProductMigrate,
  runProductReview,
  runProductVerify,
  runProductWork,
} from "../../../src/workflow/product/index.js";
import { productWorkspace } from "../support/product-workspace.js";
import { TestWorkspace } from "../support/workspace.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("current product reporting", () => {
  let workspace: TestWorkspace;
  afterEach(async () => workspace?.destroy());

  it("counts automatic product graph refreshes separately from actor queries", async () => {
    ({ workspace } = await productWorkspace());
    value(await runProductWork(await workspace.state()));
    expect(value(await capabilityUtilization(await workspace.state())).graph).toMatchObject({
      indexRefreshes: 1,
      queries: 0,
    });
  });

  it("counts real execution separately from agent assessments and expires both after source changes", async () => {
    ({ workspace } = await productWorkspace());
    value(await runProductWork(await workspace.state()));
    value(await runProductVerify(await workspace.state()));
    await workspace.write("src/value.mjs", "export const value = 2;\n");
    value(await runProductVerify(await workspace.state()));
    const review = value(await runProductReview(await workspace.state()));
    value(
      await runProductReview(await workspace.state(), {
        subjectDigest: review.subjectDigest,
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary: "Agent judges the returned value correct",
            evidence: ["C001"],
          },
        ],
      }),
    );
    const state = await workspace.state();
    const feature = state.status?.activeFeature;
    const statePath = join(workspace.root, ".visp/features", feature ?? "", "product-state.json");
    const before = await readFile(statePath);
    const summary = value(await capabilityUtilization(state));
    expect(summary.product).toMatchObject({
      features: 1,
      executions: { recorded: 2, passed: 1, failed: 1, current: 1, stale: 1 },
      reviews: { recorded: 1, current: 1, stale: 0 },
      assessments: { provenance: "agent-reported", satisfied: 1, unassessed: 0 },
    });
    expect(summary.unmigratedFeatures).toBe(0);
    expect(await readFile(statePath)).toEqual(before);
    await workspace.write("src/value.mjs", "export const value = 3;\n");
    expect(value(await capabilityUtilization(await workspace.state())).product).toMatchObject({
      executions: { recorded: 2, current: 0, stale: 2 },
      reviews: { recorded: 1, current: 0, stale: 1 },
      assessments: { satisfied: 0, unassessed: 1 },
    });
  });

  it("reads migrated intent once and counts unmigrated features without summarizing them", async () => {
    workspace = await TestWorkspace.create();
    for (const feature of ["001-migrated", "002-legacy"]) {
      await workspace.withFeature(feature);
      await workspace.withSpec(feature, [
        { id: "REQ001", statement: "Keep this outcome", priority: "must", criteria: [] },
      ]);
    }
    value(await runProductMigrate(await workspace.state(), { feature: "001-migrated" }));
    const summary = value(await capabilityUtilization(await workspace.state()));
    expect(summary.product).toMatchObject({
      features: 1,
      outcomes: { functional: 1 },
      executions: { recorded: 0 },
    });
    expect(summary.unmigratedFeatures).toBe(1);
    expect(
      await readFile(join(workspace.root, ".visp/features/002-legacy/intent.json"), "utf8"),
    ).toContain("002-legacy");
  });

  it("keeps completed migration historical and reports draft migration as incomplete", async () => {
    workspace = await TestWorkspace.create();
    await workspace.withFeature("001-completed", [{ status: "done" }]);
    await workspace.withSpec("001-completed", [
      { id: "REQ001", statement: "Historical outcome", priority: "must", criteria: [] },
    ]);
    value(await runProductMigrate(await workspace.state(), { feature: "001-completed" }));
    await workspace.withFeature("002-draft");
    value(await runProductMigrate(await workspace.state(), { feature: "002-draft" }));
    const summary = value(await capabilityUtilization(await workspace.state()));
    expect(summary.product).toMatchObject({
      features: 2,
      historicalFeatures: 1,
      incompleteBriefs: 1,
      recordedAcceptances: 0,
      slices: { historicalClosed: 1 },
      executions: { recorded: 0 },
      assessments: { satisfied: 0 },
    });
  });

  it("fails explicitly on corrupt product state instead of presenting legacy figures as current", async () => {
    const setup = await productWorkspace();
    workspace = setup.workspace;
    await workspace.write(`.visp/features/${setup.brief.feature}/product-state.json`, "broken");
    expect(await capabilityUtilization(await workspace.state())).toMatchObject({
      ok: false,
      error: { code: "ARTIFACT_INVALID" },
    });
  });
});
