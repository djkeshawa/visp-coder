import { afterEach, expect, it } from "vitest";
import { earlierSessionAuthorization } from "../../../../src/workflow/product/scopes.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace | undefined;
afterEach(async () => project?.destroy());

/** T001 authorized by session-1; the host then reports `session` and, with `prompt`, a new prompt. */
async function laterSession(session: string, prompt?: string) {
  ({ workspace: project } = await productWorkspace());
  await project.write(".visp/session/host-session.json", JSON.stringify({ session: "session-1" }));
  expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
  await project.write(".visp/session/host-session.json", JSON.stringify({ session }));
  if (prompt)
    await project.write(".visp/session/user-prompts.jsonl", `${JSON.stringify({ prompt })}\n`);
  return project.state();
}

// In a new session, workers sent to the old open task built their new request inside it.
it("sends a later session's untaken request to a feature of its own", async () => {
  const next = await runProductNext(await laterSession("session-2", "Add MEDIAN"));
  expect(next.ok && next.value).toMatchObject({
    action: "understand",
    command: `visp feature "<the user's request>"`,
    mayEdit: false,
  });
  expect(next.ok && next.value.task).toBeUndefined();
  expect(next.ok && next.value.evidence.join()).toContain("--task T001");
});

it.each([
  { case: "no untaken prompt", session: "session-2", prompt: undefined, options: {} },
  { case: "the same session", session: "session-1", prompt: "Also keep it fast", options: {} },
  { case: "a named task", session: "session-2", prompt: "Add MEDIAN", options: { task: "T001" } },
])("keeps the open task with $case", async ({ session, prompt, options }) => {
  const workspace = await laterSession(session, prompt);
  const next = await runProductNext(workspace, options);
  expect(next.ok && next.value.task).toBe("T001");
});

it("judges an earlier-session grant by the session that asks", async () => {
  const workspace = await laterSession("session-1");
  const asked = (hostSession: string) =>
    earlierSessionAuthorization(workspace, { hostSession }).then((r) => r.ok && r.value?.task);
  expect(await asked("session-2")).toBe("T001");
  expect(await asked("session-1")).toBeUndefined();
});
