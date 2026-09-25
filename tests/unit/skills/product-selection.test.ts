import { afterEach, beforeEach, expect, it } from "vitest";
import { refreshRepository } from "../../../src/graph/index.js";
import { transitionSkill } from "../../../src/skills/lifecycle.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { productSliceSchema } from "../../../src/workflow/product/model.js";
import { productSkills } from "../../../src/workflow/product/skills.js";
import { TestWorkspace } from "../support/workspace.js";

let workspace: TestWorkspace;
const slice = productSliceSchema.parse({
  id: "T001",
  goal: "Implement behavior",
  scope: { allowed: ["src/**"] },
});
beforeEach(async () => {
  workspace = await TestWorkspace.create();
});
afterEach(async () => {
  await workspace.destroy();
});

async function seed(id: string, trigger: string, body = "Inspect actual behavior.") {
  const state = await workspace.state();
  const proposed = await createProposalFromContent(
    state,
    { id, origin: "seeded", by: "operator" },
    `---\nname: ${id}\nappliesTo:\n  ${trigger}\n---\n## Procedure\n${body}\n`,
  );
  if (!proposed.ok) throw new Error(proposed.error.message);
  const admitted = await transitionSkill(state, id, "admitted", { by: "reviewer" });
  if (!admitted.ok) throw new Error(admitted.error.message);
}

it("explains unavailable selection facts without admitting an unmatched skill", async () => {
  await seed("typed-review", "language: typescript");
  const result = await productSkills(await workspace.state(), slice);
  expect(result).toMatchObject({ ok: true, value: { skills: [] } });
  if (!result.ok) return;
  expect(result.value.notes.join("\n")).toContain("typed-review: trigger did not match");
  expect(result.value.notes.join("\n")).toContain("language facts are unavailable");
});

it("reports a truncated admitted body and a matching skill excluded by budget", async () => {
  await seed("a-review", "stage: implement", "Inspect behavior. ".repeat(180));
  await seed("b-review", "stage: implement");
  const result = await productSkills(await workspace.state(), slice, 80);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.skills).toHaveLength(1);
  expect(result.value.skills[0]?.truncated).toBe(true);
  expect(result.value.notes.join("\n")).toContain("a-review: content truncated");
  expect(result.value.notes.join("\n")).toContain(
    "1 matching skill omitted by the context budget or skill limit",
  );
});

it("explains a fully exhausted context budget", async () => {
  const result = await productSkills(await workspace.state(), slice, 0);
  expect(result).toMatchObject({ ok: true, value: { skills: [] } });
  if (!result.ok) return;
  expect(result.value.notes.join("\n")).toContain("No context budget remains for skills");
});

async function index() {
  const state = await workspace.state();
  const result = await refreshRepository(
    state.paths.root,
    state.config.graph,
    state.paths.graphStore,
  );
  if (!result.ok) throw new Error(result.error.message);
}

it("selects language and entrypoint skills from current scoped graph evidence", async () => {
  await workspace.write(
    "src/value.test.ts",
    "import test from 'node:test'; test('value', () => {});\n",
  );
  await seed("typed-tests", "language: typescript\n  entrypointKind: test_entrypoint");
  await index();
  const result = await productSkills(await workspace.state(), slice);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.skills.map((entry) => entry.path)).toEqual([
    ".visp/skills/typed-tests/SKILL.md",
  ]);
  expect(result.value.notes.join("\n")).toContain("Skill graph facts observed from snapshot");
});

it("withholds stale graph facts until refresh and never guesses configured languages", async () => {
  await workspace.write("src/value.ts", "export const value = 1;\n");
  await seed("typed-review", "language: typescript");
  await index();
  await workspace.write("src/value.ts", "export const value = 2;\n");
  const stale = await productSkills(await workspace.state(), slice);
  if (!stale.ok) throw new Error(stale.error.message);
  expect(stale.value.skills).toEqual([]);
  expect(stale.value.notes.join("\n")).toContain(
    "Skill graph facts unavailable: index is divergent",
  );
  await index();
  const fresh = await productSkills(await workspace.state(), slice);
  if (!fresh.ok) throw new Error(fresh.error.message);
  expect(fresh.value.skills).toHaveLength(1);
});

it("does not select from unrelated files elsewhere in the graph", async () => {
  await workspace.write(
    "other/value.test.ts",
    "import test from 'node:test'; test('value', () => {});\n",
  );
  await workspace.write("src/value.js", "export const value = 1;\n");
  await seed("typed-tests", "language: typescript\n  entrypointKind: test_entrypoint");
  await index();
  const result = await productSkills(await workspace.state(), slice);
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.skills).toEqual([]);
  expect(result.value.notes.join("\n")).not.toContain("language facts are unavailable");
});

it("uses only an explicit task class and leaves an unspecified class unknown", async () => {
  await seed("repair-review", "taskClass: bugfix");
  const unspecified = await productSkills(await workspace.state(), slice);
  if (!unspecified.ok) throw new Error(unspecified.error.message);
  expect(unspecified.value.skills).toEqual([]);
  expect(unspecified.value.notes.join("\n")).toContain("task-class facts are unavailable");
  const classified = productSliceSchema.parse({ ...slice, taskClass: "bugfix" });
  const selected = await productSkills(await workspace.state(), classified);
  if (!selected.ok) throw new Error(selected.error.message);
  expect(selected.value.skills.map((entry) => entry.path)).toEqual([
    ".visp/skills/repair-review/SKILL.md",
  ]);
});
