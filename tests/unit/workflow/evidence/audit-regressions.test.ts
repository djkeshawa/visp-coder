import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { observationReproductionState } from "../../../../src/workflow/evidence/observations/identity.js";
import { recordObservation } from "../../../../src/workflow/evidence/observations.js";
import { resolveTaskSelection } from "../../../../src/workflow/evidence/task-selection.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

const feature = "001-audit";
let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

describe("evidence audit regressions", () => {
  it.each([runProductVerify, runProductReview])(
    "rejects explicit and dangling active IDs without writing evidence or telemetry",
    async (run) => {
      const ready = await productWorkspace();
      workspace = ready.workspace;
      const feature = ready.brief.feature;
      await workspace.write(
        "test/value.test.mjs",
        "import {writeFileSync} from 'node:fs'; writeFileSync('executed.txt', 'unexpected execution');\n",
      );
      let state = await workspace.state();
      const before = workspace.git("status", "--porcelain", "--untracked-files=all");
      const telemetryBefore = await state.files.readTextIfExists(state.paths.telemetry);
      const evidencePath = state.paths.featureFile(feature, "product-state.json");
      const evidenceBefore = await state.files.readText(evidencePath);
      const explicit = await run(state, { feature, task: "T999" });
      expect(explicit).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
      expect(workspace.git("status", "--porcelain", "--untracked-files=all")).toBe(before);
      expect(await state.files.readTextIfExists(state.paths.telemetry)).toEqual(telemetryBefore);
      if (!state.status) throw new Error("Missing status fixture");
      await state.store.writeStatus({ ...state.status, activeTask: "T999" });
      state = await workspace.state();
      const active = await run(state, { feature });
      expect(active).toMatchObject({ ok: false, error: { code: "TASK_NOT_FOUND" } });
      expect(await state.files.readTextIfExists(state.paths.telemetry)).toEqual(telemetryBefore);
      expect(await state.files.readText(evidencePath)).toEqual(evidenceBefore);
      expect(await state.files.exists("executed.txt")).toEqual({ ok: true, value: false });
    },
  );

  it("does not inherit another feature's active task and preserves deliberate feature-wide selection", () => {
    const status = {
      kind: "status" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      activeFeature: "002-other",
      activeTask: "T999",
    };
    expect(resolveTaskSelection([{ id: "T001" }], feature, undefined, status)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(resolveTaskSelection([{ id: "T001" }], feature, undefined, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(resolveTaskSelection([{ id: "T001" }], feature, "T001", status)).toEqual({
      ok: true,
      value: { id: "T001" },
    });
  });

  it("keeps case-sensitive route states and meaningful step whitespace separately", async () => {
    workspace = await TestWorkspace.create({ "src/app.ts": "export const n = 1;" });
    await workspace.withFeature(feature, [{ requirements: ["REQ001"] }]);
    await workspace.withSpec(feature, [
      {
        id: "REQ001",
        statement: "Case sensitive routing",
        priority: "must",
        criteria: [
          { id: "AC001", statement: "Account is visible", verification: "inspection: account" },
        ],
      },
    ]);
    await workspace.ensureContext(feature);
    const state = await workspace.state();
    const base = {
      feature,
      task: "T001",
      criterion: "AC001",
      source: "manual" as const,
      result: "satisfied" as const,
      note: "Observed account",
      steps: ["", "Type Alice  Smith", "   "],
    };
    const upper = await recordObservation(state, { ...base, route: "/User/Alice" });
    const lower = await recordObservation(state, {
      ...base,
      route: "/User/alice",
      steps: ["Type alice Smith"],
    });
    expect(upper.ok && lower.ok).toBe(true);
    const log = await state.store.readObservations(feature, "T001");
    expect(log.ok && log.value?.observations).toHaveLength(2);
    if (upper.ok) {
      expect(upper.value.identityVersion).toBe(2);
      expect(upper.value.steps).toEqual(["Type Alice  Smith"]);
      expect(lower.ok && upper.value.subjectHash).not.toBe(lower.ok && lower.value.subjectHash);
    }
    const bytes = await readFile(
      state.paths.evidenceFile(feature, "T001", "observations.json"),
      "utf8",
    );
    await state.store.readObservations(feature, "T001");
    expect(
      await readFile(state.paths.evidenceFile(feature, "T001", "observations.json"), "utf8"),
    ).toBe(bytes);
  });

  it("uses v1 normalization only to read legacy identities", () => {
    const input = { source: "manual" as const, route: "/User/Alice", steps: ["Type Alice  Smith"] };
    expect(observationReproductionState(input)).toMatchObject({
      route: "/User/Alice",
      steps: ["Type Alice  Smith"],
    });
    expect(observationReproductionState({ ...input, kind: "observation" })).toMatchObject({
      route: "/user/alice",
      steps: ["type alice smith"],
    });
    expect(
      observationReproductionState({ ...input, kind: "observation", identityVersion: 2 }),
    ).toEqual(observationReproductionState(input));
  });
});
