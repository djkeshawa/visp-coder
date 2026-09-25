import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { stringify } from "yaml";
import { balancedCritic } from "../../../../src/config/critic.js";
import type { Result } from "../../../../src/core/result.js";
import { runProductCritic } from "../../../../src/workflow/product/critic.js";
import { criticSelection } from "../../../../src/workflow/product/critic-store.js";
import { updateProductBrief } from "../../../../src/workflow/product/index.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { productWorkspace } from "../../support/product-workspace.js";

let setup: Awaited<ReturnType<typeof productWorkspace>>;
const preset = balancedCritic("codex");
if (!preset) throw new Error("Missing preset");
const config = { ...preset, maxCalls: 2 };
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const run = async (input: object) =>
  runProductCritic(await setup.workspace.state(), { task: "T001", ...input });
const record = async () => value(await readProductRecord(await setup.workspace.state()));
beforeEach(async () => {
  setup = await productWorkspace({ critic: true });
  value(await run({ operation: "configure", config }));
});
afterEach(async () => {
  await setup.workspace.destroy();
});
const revise = async () =>
  updateProductBrief(await setup.workspace.state(), {
    brief: {
      ...setup.brief,
      outcomes: setup.brief.outcomes.map((outcome) => ({
        ...outcome,
        statement: "The public value remains exactly two",
      })),
    },
    intentChange: {
      reason: "Clarify the promised public value",
      provenance: "agent-proposed clarification; not human approval",
    },
  });

it("preserves foreign-worktree and retired-selection history while revising the active local selection", async () => {
  const selected = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
  const text = await readFile(selected.path, "utf8");
  const state = JSON.parse(text);
  const foreign = join(dirname(selected.path), "foreign.json");
  const retired = join(dirname(selected.path), "retired.json");
  const foreignText = JSON.stringify({ ...state, root: "another-worktree" });
  const retiredText = JSON.stringify({ ...state, task: "T999" });
  await writeFile(foreign, foreignText);
  await writeFile(retired, retiredText);
  value(await revise());
  expect(await readFile(foreign, "utf8")).toBe(foreignText);
  expect(await readFile(retired, "utf8")).toBe(retiredText);
  const next = JSON.parse(await readFile(selected.path, "utf8"));
  expect(next.intent).not.toBe(state.intent);
  expect(next.attempts).toEqual(state.attempts);
  expect(next.intentRevisions).toHaveLength(1);
  value(await run({ operation: "reconcile", reason: "Already reconciled" }));
  expect(JSON.parse(await readFile(selected.path, "utf8"))).toEqual(next);
});

it.each(["schema", "feature"])(
  "aborts the entire brief transaction for invalid %s history",
  async (kind) => {
    const before = await record();
    const selected = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
    const state = JSON.parse(await readFile(selected.path, "utf8"));
    await writeFile(
      selected.path,
      JSON.stringify(
        kind === "schema" ? { version: 1 } : { ...state, feature: "999-other-feature" },
      ),
    );
    expect(await revise()).toMatchObject({ ok: false, error: { code: "ARTIFACT_INVALID" } });
    expect((await record()).briefText).toBe(before.briefText);
    expect((await record()).stateText).toBe(before.stateText);
  },
);

it("invalidates an in-flight design result on intent revision without refunding its call", async () => {
  if (!config) throw new Error("preset");
  const capabilities = {
    harness: "codex",
    model: config.model,
    reasoningEffort: "high",
    freshContext: true,
    readOnly: true,
    images: false,
    delegationAllowed: true,
  };
  const prepared = value(
    await run({ operation: "prepare", phase: "understanding", capabilities }),
  ) as { attempt: string };
  value(await revise());
  const selected = value(await criticSelection(await setup.workspace.state(), { task: "T001" }));
  const state = JSON.parse(await readFile(selected.path, "utf8"));
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]).toMatchObject({ id: prepared.attempt, status: "unavailable" });
  expect(state.attempts[0].intent).not.toBe(state.intent);
  expect(await run({ operation: "status" })).toMatchObject({
    ok: true,
    value: { callsUsed: 1, callsRemaining: 1, next: "review" },
  });
  expect((await record()).state.reviews).toEqual([]);
});

it("cannot reconcile an out-of-band brief edit into authorized intent", async () => {
  const before = await record();
  await setup.workspace.write(
    join(".visp/features", setup.brief.feature, "brief.yaml"),
    stringify({ ...setup.brief, goal: "A different unchecked promise" }),
  );
  expect(
    await run({ operation: "reconcile", reason: "Attempt to bless an external edit" }),
  ).toMatchObject({ ok: false });
  const statePath = join(
    setup.workspace.root,
    ".visp/features",
    setup.brief.feature,
    "product-state.json",
  );
  expect(await readFile(statePath, "utf8")).toBe(before.stateText);
});
