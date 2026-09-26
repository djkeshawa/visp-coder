import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TestProject } from "../support/project.js";

/**
 * In a two-session benchmark the user stated API conventions "for all later work, including
 * future sessions". Fresh sessions with the next request applied 3 of 24 convention checks
 * although VISP's records held the conventions; restated in the request, 24 of 24.
 */
let project: TestProject;

beforeAll(async () => {
  project = await TestProject.create({
    "src/items.ts": "export const items = () => [];\n",
  });
  project.run("init", "--harness", "generic");
  project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");
  await project.installShim();
  project.commit("add visp", { skipHooks: true });
});

afterAll(async () => {
  await project.destroy();
});

async function userPrompt(prompt: string): Promise<void> {
  const directory = join(project.root, ".visp/session");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "user-prompts.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`,
  );
}

async function workOn(feature: string) {
  await project.authorBrief(feature, {
    outcomes: [{ id: "O001", kind: "functional", statement: "Items are listed" }],
    checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Change the items module",
        outcomes: ["O001"],
        scope: { allowed: ["src/**/*.ts"] },
        checks: ["C001"],
      },
    ],
  });
  expect(project.run("critic", "--off").exitCode).toBe(0);
  return project.run("work", "--feature", feature, "--task", "T001");
}

it("captures rules stated for later work and puts them in every later feature", async () => {
  await userPrompt(
    [
      "Our API conventions apply to this change and to all later work, including future sessions:",
      "",
      "- Money is an integer number of cents in a field ending in Cents.",
      "- Nothing is hard-deleted; a deleted resource answers 410 gone.",
      "",
      "The change: list items.",
    ].join("\n"),
  );
  const first = project.run("feature", "List items");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  expect(first.stdout).toContain("R001 Money is an integer number of cents");
  expect(JSON.parse(await project.read(".visp/rules.json")).rules).toHaveLength(2);
  const firstWork = await workOn("001-list-items");
  expect(firstWork.exitCode, firstWork.stdout + firstWork.stderr).toBe(0);
  project.git("add", "-A");
  project.commit("list items", { skipHooks: true });

  await userPrompt("Add prices to items. Our conventions from before still apply.");
  const second = project.run("feature", "Add prices");
  expect(second.exitCode, second.stdout + second.stderr).toBe(0);
  const brief = await project.read(".visp/features/002-add-prices/brief.yaml");
  expect(brief).toContain("Add prices to items.");
  expect(brief).toContain("R002 Nothing is hard-deleted");

  const work = await workOn("002-add-prices");
  expect(work.exitCode, work.stdout + work.stderr).toBe(0);
  expect(work.stdout).toContain(
    "Project rules the user stated for all later work on this project (they apply here too):\nR001 Money is an integer number of cents",
  );
});

it("captures nothing from an ordinary request", async () => {
  await userPrompt("Add a search box.\n\n- matches are case-insensitive");
  const third = project.run("feature", "Search box");
  expect(third.exitCode, third.stdout + third.stderr).toBe(0);
  expect(JSON.parse(await project.read(".visp/rules.json")).rules).toHaveLength(2);
});

// A wrongly captured rule would otherwise join every later request.
it("lists recorded rules and removes one the user did not mean", () => {
  expect(project.run("rules").stdout).toContain("R002 Nothing is hard-deleted");
  const removed = project.run("rules", "remove", "R002");
  expect(removed.exitCode, removed.stdout + removed.stderr).toBe(0);
  const listed = project.run("rules").stdout;
  expect(listed).toContain("R001 Money");
  expect(listed).not.toContain("R002");
  expect(project.run("rules", "remove", "R009").exitCode).not.toBe(0);
});
