import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProductFeature } from "../../../../src/workflow/product/brief.js";
import { FEATURE_STARTING_FILE } from "../../../../src/workflow/product/host-prompts.js";
import { runProductNext } from "../../../../src/workflow/product/status.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

async function marker(ageMs: number) {
  const fixture = await productWorkspace();
  workspace = fixture.workspace;
  const state = await fixture.workspace.state();
  const path = join(state.paths.sessionDir, FEATURE_STARTING_FILE);
  await writeFile(path, `${JSON.stringify({ at: Date.now() - ageMs })}\n`);
  return { fixture, path };
}

it("tells next and work to wait while visp feature is still recording a request", async () => {
  const { fixture } = await marker(5_000);
  const next = await runProductNext(await fixture.workspace.state());
  expect(next.ok && next.value).toMatchObject({
    action: "wait",
    command: "visp next",
    mayEdit: false,
    objective: expect.stringContaining("still recording the request"),
  });
  const work = await runProductWork(await fixture.workspace.state());
  expect(work).toMatchObject({
    ok: false,
    error: { code: "STAGE_BLOCKED", message: expect.stringContaining("do not run it again") },
  });
  // Naming the feature or task means the worker chose where to continue.
  const named = await runProductNext(await fixture.workspace.state(), { task: "T001" });
  expect(named.ok && named.value.action).not.toBe("wait");
});

it("ignores a marker left by a killed visp feature", async () => {
  const { fixture } = await marker(121_000);
  const next = await runProductNext(await fixture.workspace.state());
  expect(next.ok && next.value.action).not.toBe("wait");
});

it("clears the marker when visp feature finishes, also on an error", async () => {
  const { fixture, path } = await marker(0);
  const state = await fixture.workspace.state();
  // A feature on a dirty tree fails; the marker is removed anyway.
  await fixture.workspace.write("src/value.mjs", "export const value = 9;\n");
  await utimes(path, new Date(), new Date());
  const created = await createProductFeature(state, { goal: "Another change" });
  expect(created.ok).toBe(false);
  await expect(readFile(path, "utf8")).rejects.toThrow();
});
