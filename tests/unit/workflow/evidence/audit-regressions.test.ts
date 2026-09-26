import { afterEach, describe, expect, it } from "vitest";
import { observationReproductionState } from "../../../../src/workflow/evidence/observations/identity.js";
import { resolveTaskSelection } from "../../../../src/workflow/evidence/task-selection.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductReview } from "../../../../src/workflow/product/review.js";
import { legacyStore } from "../../support/legacy-store.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

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
      await legacyStore(state).writeStatus({ ...state.status, activeTask: "T999" });
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
