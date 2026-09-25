import { afterEach, expect, it } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

// Without a runnable check, `done` has nothing to execute and the critic has no evidence.
it("refuses to authorize a slice without a runnable check and says how to add one", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const updated = await updateProductBrief(await workspace.state(), {
    reason: "Drop every check",
    brief: {
      ...fixture.brief,
      checks: [],
      slices: fixture.brief.slices.map((slice) => ({ ...slice, checks: [] })),
    },
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  const work = await runProductWork(await workspace.state(), { task: "T001" });
  expect(work.ok).toBe(false);
  if (work.ok) return;
  expect(work.error.message).toContain("T001 has no runnable check");
  expect(work.error.recovery).toContain('"checks"');
});

// Weak workers spent about six minutes on planning before a first check on small changes.
it("works the whole request as one slice when given a check on a feature without slices", async () => {
  const { createProductFeature } = await import("../../../../src/workflow/product/brief.js");
  const { TestWorkspace } = await import("../../support/workspace.js");
  workspace = await TestWorkspace.create({
    "src/value.mjs": "export const value = 1;\n",
    "test/value.test.mjs":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('v',()=>assert.equal(value,2));\n",
  });
  await workspace.installFoundation();
  workspace.commit("install foundation");
  const feature = await createProductFeature(await workspace.state(), {
    goal: "Return two from the public module",
  });
  if (!feature.ok) throw new Error(feature.error.message);
  const work = await runProductWork(await workspace.state(), {
    check: `${process.execPath} --test test/value.test.mjs`,
  });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  if (!work.ok) return;
  expect(work.value.task).toBe("T001");
  expect(work.value.scope.allowed).toEqual(["**"]);
  expect(work.value.checks).toEqual([expect.objectContaining({ id: "C001", outcomes: ["O001"] })]);
});

it("adds the given check to a slice that has none", async () => {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const updated = await updateProductBrief(await workspace.state(), {
    reason: "Drop every check",
    brief: {
      ...fixture.brief,
      checks: [],
      slices: fixture.brief.slices.map((slice) => ({ ...slice, checks: [] })),
    },
  });
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  const work = await runProductWork(await workspace.state(), {
    task: "T001",
    check: `${process.execPath} --test test/value.test.mjs`,
  });
  expect(work.ok, JSON.stringify(work)).toBe(true);
  expect(work.ok && work.value.checks.map((check) => check.id)).toEqual(["T001-C1"]);
});
