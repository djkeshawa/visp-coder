import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requestChunks } from "../../../src/memory/memory-service.js";
import { TestProject } from "../support/project.js";

/**
 * Weak workers applied what their request carried and never looked knowledge up. With
 * `memory.service`, VISP records earlier requests in Visp Memory and adds the decisions it
 * selects for a new request to that request. A fake service stands in for Visp Memory.
 */
let project: TestProject;
const log = () => join(project.root, ".memory-log");

beforeAll(async () => {
  project = await TestProject.create({ "src/items.ts": "export const items = () => [];\n" });
  project.run("init", "--harness", "generic");
  project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");
  await project.installShim();
  const fake = join(project.root, ".bin", "fake-visp-memory");
  await writeFile(
    fake,
    [
      "#!/bin/sh",
      `if [ "$1" = decision ]; then printf '%s\\n' "$2" >> "${log()}"; exit 0; fi`,
      `if [ "$1" = brief ]; then printf '%s' '{"abstained": false, "sections": {"decisions": [{"content": "Decision: An archived item cannot be reserved: 409 item_archived.\\nReasoning: feature 001"}], "warnings": [], "knowledge": []}}'; fi`,
    ].join("\n"),
  );
  await chmod(fake, 0o755);
  const config = await project.read("visp.yml");
  await writeFile(
    join(project.root, "visp.yml"),
    config.replace(/memory:\n(\s+#[^\n]*\n)?\s+enabled: true/, (block) => `${block}\n  service:\n    command: ${fake}`),
  );
  project.commit("add visp", { skipHooks: true });
});

afterAll(async () => {
  await project.destroy();
});

async function userPrompt(prompt: string): Promise<void> {
  await mkdir(join(project.root, ".visp/session"), { recursive: true });
  await writeFile(
    join(project.root, ".visp/session/user-prompts.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), prompt })}\n`,
  );
}

it("records earlier requests and carries the selected decisions into the next request", async () => {
  await userPrompt(
    "Add item archiving.\n\n1. An archived item cannot be reserved: 409 item_archived.\n2. Items hold at most 10000 units.",
  );
  const first = project.run("feature", "Archive items");
  expect(first.exitCode, first.stdout + first.stderr).toBe(0);
  project.git("add", "-A");
  project.commit("archive items", { skipHooks: true });

  await userPrompt("Add bundle reservations with a lines shape.");
  const second = project.run("feature", "Bundles");
  expect(second.exitCode, second.stdout + second.stderr).toBe(0);
  expect((await readFile(log(), "utf8")).trim().split("\n")).toEqual([
    "1. An archived item cannot be reserved: 409 item_archived.",
    "2. Items hold at most 10000 units.",
  ]);
  const brief = await project.read(".visp/features/002-bundles/brief.yaml");
  expect(brief).toContain("M1 An archived item cannot be reserved: 409 item_archived.");

  await project.authorBrief("002-bundles", {
    outcomes: [{ id: "O001", kind: "functional", statement: "Bundles reserve all lines" }],
    checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Add bundles",
        outcomes: ["O001"],
        scope: { allowed: ["src/**/*.ts"] },
        checks: ["C001"],
      },
    ],
  });
  expect(project.run("critic", "--off").exitCode).toBe(0);
  const work = project.run("work", "--feature", "002-bundles", "--task", "T001");
  expect(work.exitCode, work.stdout + work.stderr).toBe(0);
  expect(work.stdout).toContain("M1 An archived item cannot be reserved: 409 item_archived.");
});

it("does not record the blocks VISP appended to a request", () => {
  expect(
    requestChunks(
      "Add prices to items, stored in integer cents.\n\nProject rules the user stated for all later work on this project (they apply here too):\nR001 Money is integer cents.",
    ),
  ).toEqual(["Add prices to items, stored in integer cents."]);
});
