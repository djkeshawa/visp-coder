import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { createProductFeature } from "../../../../src/workflow/product/feature-create.js";
import { readProductRecord } from "../../../../src/workflow/product/store.js";
import { TestWorkspace } from "../../support/workspace.js";

let workspace: TestWorkspace | undefined;
afterEach(async () => {
  await workspace?.destroy();
  workspace = undefined;
});

const REQUEST = "Show the weekly report with totals for every team on the dashboard page.";

async function project(critic?: Record<string, unknown>): Promise<TestWorkspace> {
  const created = await TestWorkspace.create(
    { "src/items.ts": "export const items = 1;\n" },
    { critic: Boolean(critic) },
  );
  workspace = created;
  await created.installFoundation();
  if (critic) {
    const config = parse(await readFile(join(created.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, ...critic };
    await created.write("visp.yml", stringify(config));
  }
  await created.write(".gitignore", ".visp/session/\n");
  created.commit("configure");
  return created;
}

it("refuses a feature when the recorded project rules are unreadable", async () => {
  const created = await project();
  await created.write(".visp/rules.json", "{ not json");
  created.commit("break rules");
  const result = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(result.ok).toBe(false);
});

it("refuses a feature when the host prompt record cannot be read", async () => {
  const created = await project();
  await mkdir(join(created.root, ".visp/session/user-prompts.jsonl"), { recursive: true });
  const result = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(result.ok).toBe(false);
});

it("refuses a feature when the features directory cannot be listed", async () => {
  const created = await project();
  const state = await created.state();
  await rm(join(created.root, ".visp/features"), { recursive: true, force: true });
  await writeFile(join(created.root, ".visp/features"), "not a directory");
  const result = await createProductFeature(state, {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(result.ok).toBe(false);
});

it("refuses a feature when the status file turned unreadable after the workspace loaded", async () => {
  const created = await project();
  const state = await created.state();
  await writeFile(state.paths.status, "{ not json");
  const result = await createProductFeature(state, { goal: "Weekly report", sourceBrief: REQUEST });
  expect(result.ok).toBe(false);
});

it("records manual critic mode in the new feature's state", async () => {
  const created = await project({ mode: "manual" });
  const result = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const record = await readProductRecord(await created.state(), {
    feature: result.value.brief.feature,
  });
  expect(record.ok && record.value.state.criticManual).toBe(true);
});

it("leaves the branch out of the intent on a detached head", async () => {
  const created = await project();
  created.git("checkout", "--detach");
  const result = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.intent.branch).toBeUndefined();
});

it("skips an earlier feature whose intent is unreadable or predates source briefs", async () => {
  const created = await project();
  const first = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const features = join(created.root, ".visp/features");
  const intentPath = join(features, first.value.brief.feature, "intent.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8"));
  // Same goal and risk, but the intent has no source brief: it cannot match a repeated request.
  delete intent.sourceBrief;
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
  await mkdir(join(features, "000-broken"), { recursive: true });
  await writeFile(join(features, "000-broken", "intent.json"), "{ not json");
  created.commit("age the features");
  const second = await createProductFeature(await created.state(), {
    goal: "Weekly report",
    sourceBrief: REQUEST,
  });
  expect(second.ok ? "" : second.error.message).toBe("");
  if (second.ok) {
    expect(second.value.duplicateOf).toBeUndefined();
    expect(second.value.brief.feature).not.toBe(first.value.brief.feature);
  }
});
