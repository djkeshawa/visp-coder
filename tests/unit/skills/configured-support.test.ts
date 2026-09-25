import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { transitionSkill } from "../../../src/skills/lifecycle.js";
import { readCurrentLineage, reconcileLineage } from "../../../src/skills/lineage.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { readIndex } from "../../../src/skills/store.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
const feature = "001-supported";
const content =
  "---\nname: retained-check\nappliesTo:\n  paths: [src/**]\n---\n## Procedure\nCheck return values.\n";
beforeEach(async () => {
  workspace = await TestWorkspace.create();
  await workspace.withFeature(
    feature,
    ["T001", "T002", "T003"].map((id) => ({ id, status: "done" })),
  );
});
afterEach(async () => workspace.destroy());
async function threshold(minSupport: number) {
  const state = await workspace.state();
  const config = parse(await readFile(state.paths.config, "utf8"));
  config.skills = { ...config.skills, minSupport };
  await workspace.write("visp.yml", stringify(config));
}
async function propose() {
  return createProposalFromContent(
    await workspace.state(),
    {
      id: "retained-check",
      origin: "derived",
      feature,
      fromTask: ["T001", "T002", "T003"],
    },
    content,
  );
}
it("uses authored support thresholds for proposal, admission and continued eligibility", async () => {
  await threshold(4);
  expect((await propose()).ok).toBe(false);
  expect(await readIndex(await workspace.state())).toMatchObject({
    ok: true,
    value: { skills: [] },
  });
  await threshold(2);
  expect(await propose()).toMatchObject({ ok: true, value: { minSupport: 2, state: "proposed" } });
  await threshold(4);
  expect(
    (
      await transitionSkill(await workspace.state(), "retained-check", "admitted", {
        by: "reviewer",
      })
    ).ok,
  ).toBe(false);
  await threshold(3);
  expect(
    (
      await transitionSkill(await workspace.state(), "retained-check", "admitted", {
        by: "reviewer",
      })
    ).ok,
  ).toBe(true);
  expect(await readCurrentLineage(await workspace.state())).toMatchObject({
    ok: true,
    value: [{ state: "admitted" }],
  });
  await threshold(4);
  expect(await readCurrentLineage(await workspace.state())).toMatchObject({
    ok: true,
    value: [{ state: "orphaned" }],
  });
  expect((await reconcileLineage(await workspace.state())).ok).toBe(true);
  await threshold(1);
  expect(await readCurrentLineage(await workspace.state())).toMatchObject({
    ok: true,
    value: [{ state: "orphaned" }],
  });
});
