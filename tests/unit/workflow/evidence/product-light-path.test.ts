import { afterEach, expect, it } from "vitest";
import {
  createProductFeature,
  updateProductBrief,
} from "../../../../src/workflow/product/brief.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

function currentProject(): TestWorkspace {
  if (!project) throw new Error("Missing product workspace");
  return project;
}

async function emptyFeature() {
  project = await TestWorkspace.create({ "test/value.test.mjs": "" });
  await project.installFoundation();
  project.commit("install foundation");
  const started = await createProductFeature(await project.state(), { goal: "Keep the value" });
  if (!started.ok) throw new Error(started.error.message);
  return started.value.brief;
}

it("links an existing must outcome instead of rewriting it on the light path", async () => {
  const brief = await emptyFeature();
  const revised = await updateProductBrief(await currentProject().state(), {
    feature: brief.feature,
    patch: { outcomes: [{ id: "O001", kind: "functional", statement: "Value stays stable" }] },
    reason: "Record the requested result",
  });
  expect(revised.ok).toBe(true);
  const worked = await runProductWork(await currentProject().state(), {
    check: "node --test test/value.test.mjs",
  });
  expect(worked.ok).toBe(true);
  if (worked.ok)
    expect(worked.value.outcomes).toContainEqual(
      expect.objectContaining({ statement: "Value stays stable" }),
    );
});

it("routes incomplete briefs to completion before suggesting work", async () => {
  const brief = await emptyFeature();
  const revised = await updateProductBrief(await currentProject().state(), {
    feature: brief.feature,
    patch: { incomplete: true },
    reason: "More information is needed",
  });
  expect(revised.ok).toBe(true);
  const next = await runProductNext(await currentProject().state());
  expect(next.ok && next.value.command).toContain("visp brief");
  expect(next.ok && next.value.objective).toContain("incomplete:false");
});
