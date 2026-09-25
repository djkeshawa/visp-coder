import { afterEach, expect, it } from "vitest";
import {
  hasProductFeature,
  runProductNext,
  runProductReport,
  runProductStatus,
} from "../../../../src/workflow/product/status.js";
import { productWorkspace } from "../../support/product-workspace.js";
import { TestWorkspace } from "../../support/workspace.js";

const projects: TestWorkspace[] = [];
afterEach(async () => {
  for (const project of projects.splice(0)) await project.destroy();
});

it("distinguishes absent active features from explicitly selected product features without writing state", async () => {
  const empty = await TestWorkspace.create();
  projects.push(empty);
  const state = await empty.state();
  expect(await hasProductFeature(state)).toBe(false);
  expect(await hasProductFeature(state, "001-missing")).toBe(false);
  const created = await productWorkspace();
  projects.push(created.workspace);
  const loaded = await created.workspace.state();
  expect(await hasProductFeature(loaded)).toBe(true);
  expect(await hasProductFeature({ ...loaded, status: undefined }, created.brief.feature)).toBe(
    true,
  );
});

it("propagates invalid slice selection consistently through next, status and report without modifying the feature", async () => {
  const created = await productWorkspace();
  projects.push(created.workspace);
  const state = await created.workspace.state();
  const path = state.paths.featureFile(created.brief.feature, "product-state.json");
  const before = await state.files.readText(path);
  const selection = { feature: created.brief.feature, task: "T999" };
  const next = await runProductNext(state, selection);
  expect(next.ok).toBe(false);
  if (next.ok) throw new Error("Unknown slice accepted");
  expect(next.error.code).toBe("TASK_NOT_FOUND");
  expect(await runProductStatus(state, selection)).toEqual(next);
  expect(await runProductReport(state, selection)).toEqual(next);
  expect(await state.files.readText(path)).toEqual(before);
});
