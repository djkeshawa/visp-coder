import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { TestWorkspace } from "../../support/workspace.js";

// The model call is replaced: these tests cover which path `visp feature` takes.
const extractor = vi.fn();
vi.mock("../../../../src/workflow/product/rule-extraction.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  codexRuleExtractor: () => extractor,
}));

const { createProductFeature } = await import("../../../../src/workflow/product/brief.js");

let workspace: TestWorkspace | undefined;

afterEach(() => {
  extractor.mockReset();
  workspace = undefined;
});

async function project(critic?: Record<string, unknown>) {
  workspace = await TestWorkspace.create(
    { "src/items.ts": "export const items = 1;\n" },
    { critic: Boolean(critic) },
  );
  await workspace.installFoundation();
  if (critic) {
    const config = parse(await readFile(join(workspace.root, "visp.yml"), "utf8"));
    config.critic = { ...config.critic, ...critic };
    await workspace.write("visp.yml", stringify(config));
  }
  await workspace.write(".gitignore", ".visp/session/\n");
  workspace.commit("configure");
}

async function feature(goal: string, ...prompts: string[]) {
  if (!workspace) throw new Error("no workspace");
  await mkdir(join(workspace.root, ".visp/session"), { recursive: true });
  await writeFile(
    join(workspace.root, ".visp/session/user-prompts.jsonl"),
    prompts
      .map((prompt) => `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`)
      .join(""),
  );
  const created = await createProductFeature(await workspace.state(), { goal, branch: false });
  if (!created.ok) throw new Error(created.error.message);
  workspace.commit(goal);
  return created.value;
}

async function recorded(): Promise<string[]> {
  if (!workspace) throw new Error("no workspace");
  const text = await readFile(join(workspace.root, ".visp/rules.json"), "utf8");
  return (JSON.parse(text) as { rules: { text: string }[] }).rules.map((rule) => rule.text);
}

it("records rules by phrase matching when no reviewer model reads them", async () => {
  await project();
  const first = await feature("List items", "From now on, never log request bodies.");
  expect(first.projectRules?.map((rule) => rule.text)).toEqual([
    "From now on, never log request bodies.",
  ]);
  expect(extractor).not.toHaveBeenCalled();
  const second = await feature("Add prices", "Add prices to items.");
  expect(second.brief.originalRequest).toBe("Add prices to items.");
  expect(await recorded()).toEqual(["From now on, never log request bodies."]);
});

it("records the rules the reviewer's model quotes from all recorded prompts", async () => {
  await project({ enabled: true, harness: "codex", launch: "codex-exec" });
  extractor.mockResolvedValue([
    { rule: "Use four spaces for indentation.", quote: "from now on use four spaces" },
    { rule: "Invented rule.", quote: "nothing like this was said" },
  ]);
  await feature("Indent", "From now on, use tabs.", "Scratch that: from now on use four spaces.");
  expect(extractor).toHaveBeenCalledWith([
    "From now on, use tabs.",
    "Scratch that: from now on use four spaces.",
  ]);
  expect(await recorded()).toEqual(["Use four spaces for indentation."]);
});

it("falls back to phrase matching when the model fails", async () => {
  await project({ enabled: true, harness: "codex", launch: "codex-exec" });
  extractor.mockRejectedValue(new Error("offline"));
  await feature("List items", "Going forward, every endpoint logs the request id.");
  expect(await recorded()).toEqual(["Going forward, every endpoint logs the request id."]);
});
