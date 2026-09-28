import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { AUTHORIZATION_CHECK } from "../../src/harness/authorization-check.js";
import { branchFeatures } from "../../src/workflow/product/branch-scope.js";
import { updateProductBrief } from "../../src/workflow/product/brief.js";
import { allocateFeatureId } from "../../src/workflow/product/feature-id.js";
import { mergeProjectRules, removeProjectRule } from "../../src/workflow/product/project-rules.js";
import { runProductNext, runProductStatus } from "../../src/workflow/product/status.js";
import { runProductWork } from "../../src/workflow/product/work.js";
import { authorizedScopes } from "../../src/workflow/state.js";
import { productWorkspace } from "../unit/support/product-workspace.js";
import type { TestWorkspace } from "../unit/support/workspace.js";

let project: TestWorkspace;
afterEach(async () => project?.destroy());

it("recovers next, status and authorization after switching away from a feature", async () => {
  ({ workspace: project } = await productWorkspace());
  project.git("switch", "-c", "feature/test");
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  project.commit("feature");
  project.git("switch", "main");
  const state = await project.state();
  expect(state.status?.activeFeature).toBeUndefined();
  const next = await runProductNext(state);
  expect(next.ok).toBe(true);
  expect(next.ok && next.value.objective).toContain("main");
  expect(next.ok && next.value.command).not.toContain("visp feature");
  expect((await runProductStatus(state)).ok).toBe(true);
  expect(await authorizedScopes(state)).toEqual({ ok: true, value: [] });
  expect(
    execFileSync(process.execPath, ["-e", AUTHORIZATION_CHECK], {
      cwd: project.root,
      encoding: "utf8",
    }).trim(),
  ).toBe("inactive");
  await project.write("ordinary.txt", "ordinary human edit\n");
  project.commit("ordinary commit");
});

it("ignores an implicit task removed by stash but explains an explicit missing task", async () => {
  ({ workspace: project } = await productWorkspace());
  project.commit("brief");
  const state = await project.state();
  const status = await runProductStatus(state);
  if (!status.ok || !status.value.brief) throw new Error("brief");
  const first = status.value.brief.slices[0];
  expect(
    (
      await updateProductBrief(state, {
        patch: { slices: [{ ...first, id: "T999" }] },
        reason: "Temporary slice",
      })
    ).ok,
  ).toBe(true);
  expect((await runProductWork(await project.state(), { task: "T999" })).ok).toBe(true);
  project.git("stash", "push", "-m", "temporary slice");
  expect((await runProductNext(await project.state())).ok).toBe(true);
  expect((await runProductStatus(await project.state())).ok).toBe(true);
  expect((await runProductWork(await project.state())).ok).toBe(true);
  const explicit = await runProductWork(await project.state(), { task: "T999" });
  expect(explicit.ok).toBe(false);
  expect(!explicit.ok && explicit.error.message).toContain("T001");
});

it("allocates distinct feature and rule ids on parallel branches", async () => {
  ({ workspace: project } = await productWorkspace());
  const ids = await Promise.all(
    Array.from({ length: 3 }, () => allocateFeatureId(project.root, [], "Add the same thing")),
  );
  expect(ids.every((id) => id.ok)).toBe(true);
  expect(new Set(ids.map((id) => id.ok && id.value)).size).toBe(3);
  const first = mergeProjectRules([], ["Use tabs"], "001-one", "now").added[0];
  const second = mergeProjectRules([], ["Use spaces"], "001-two", "now").added[0];
  expect(first?.id).not.toBe(second?.id);
  expect(first?.id).toBe(mergeProjectRules([], ["Use tabs"], "001-two", "later").added[0]?.id);
});

it("refuses ambiguous legacy rule removal", async () => {
  ({ workspace: project } = await productWorkspace());
  await project.write(
    ".visp/rules.json",
    JSON.stringify({
      version: 1,
      rules: ["One", "Two"].map((text) => ({
        id: "R001",
        text,
        feature: "001-old",
        capturedAt: "now",
      })),
    }),
  );
  const removed = await removeProjectRule(await project.state(), "R001");
  expect(removed.ok).toBe(false);
  expect(!removed.ok && removed.error.message).toContain("ambiguous");
});

it("selects every changed feature after branch rename and merge", async () => {
  ({ workspace: project } = await productWorkspace());
  const base = project.git("rev-parse", "HEAD").trim();
  const feature = (await project.state()).status?.activeFeature;
  project.git("switch", "-c", "first");
  project.commit("first feature");
  project.git("switch", "-c", "second", base);
  await project.withFeature("002-second");
  project.commit("second feature");
  project.git("merge", "first", "--no-edit");
  const selected = await branchFeatures(await project.state(), { base, branch: "renamed" });
  expect(selected.ok && selected.value.sort()).toEqual([feature, "002-second"].sort());
});
