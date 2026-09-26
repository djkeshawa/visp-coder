import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCurrentLineage, reconcileLineage, supportFor } from "../../../src/skills/lineage.js";
import { createProposalFromContent } from "../../../src/skills/proposal.js";
import { upsert } from "../../../src/skills/store.js";
import { legacyStore } from "../support/legacy-store.js";
import { TestWorkspace } from "../support/workspace.js";

const FEATURE = "001-first-feature";
const CONTENT =
  "---\nname: reusable-check\nappliesTo:\n  language: typescript\n---\n## Procedure\nCheck return values.\n";
let workspace: TestWorkspace;

beforeEach(async () => {
  workspace = await TestWorkspace.create();
  await workspace.withFeature(
    FEATURE,
    ["T001", "T002", "T003"].map((id) => ({ id, status: "done" })),
  );
});
afterEach(async () => workspace.destroy());

async function admitted() {
  const state = await workspace.state();
  const proposed = await createProposalFromContent(
    state,
    {
      id: "reusable-check",
      origin: "derived",
      feature: FEATURE,
      fromTask: ["T001", "T002", "T003"],
    },
    CONTENT,
  );
  if (!proposed.ok) throw new Error(proposed.error.message);
  const record = { ...proposed.value, state: "admitted" as const, admittedBy: "reviewer" };
  const saved = await upsert(state, record);
  if (!saved.ok) throw new Error(saved.error.message);
  return record;
}

async function changeTask(status: "done" | "pending", title?: string) {
  const state = await workspace.state();
  const graph = await legacyStore(state).readTasks(FEATURE);
  if (!graph.ok) throw new Error(graph.error.message);
  await legacyStore(state).writeTasks({
    ...graph.value,
    tasks: graph.value.tasks.map((task) =>
      task.id === "T001" ? { ...task, status, ...(title ? { title } : {}) } : task,
    ),
  });
}

describe("qualified learning support", () => {
  it("refuses to infer which equally named task a legacy citation meant", async () => {
    await workspace.withFeature("002-second-feature", [{ id: "T001", status: "done" }]);
    const support = await supportFor(await workspace.state(), undefined, ["T001"]);
    expect(support.closed).toEqual([]);
    expect(support.lost).toEqual(["T001"]);
  });

  it("pins feature and task content when proposing", async () => {
    const record = await admitted();
    expect(record.support).toHaveLength(3);
    expect(record.support?.[0]).toMatchObject({ feature: FEATURE, task: "T001" });
    expect(record.support?.[0]?.taskHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("suspends as soon as support drops below the admission threshold", async () => {
    await admitted();
    await changeTask("pending");
    const current = await readCurrentLineage(await workspace.state());
    expect(current.ok && current.value[0]?.state).toBe("orphaned");
  });

  it("invalidates a changed closed task even if its id is unchanged", async () => {
    await admitted();
    await changeTask("done", "A different task using the same id");
    const current = await readCurrentLineage(await workspace.state());
    expect(current.ok && current.value[0]?.state).toBe("orphaned");
  });

  it("does not reactivate a suspended skill without reviewed admission", async () => {
    await admitted();
    await changeTask("pending");
    await reconcileLineage(await workspace.state());
    await changeTask("done");
    const current = await readCurrentLineage(await workspace.state());
    expect(current.ok && current.value[0]?.state).toBe("orphaned");
  });
});
