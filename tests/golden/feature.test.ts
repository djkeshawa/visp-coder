import { afterEach, it, vi } from "vitest";
import { DECLINED_TESTER, FakeModels } from "./support/fake-models.js";
import { CODEX, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * `visp feature` as the worker and VISP's models see it: with and without standing project
 * rules in the user's recorded prompts, and with and without notes recalled from earlier
 * features. The rule reader and memory gate prompts are captured where VISP launches them.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const RULE_PROMPT = `From now on, never log request bodies.\n\n${REQUEST}`;

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

/** What the host hooks record for each user prompt, read by `visp feature`. */
async function recordPrompts(...prompts: string[]) {
  await project?.workspace.write(
    ".visp/session/user-prompts.jsonl",
    prompts
      .map((prompt) => `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", prompt })}\n`)
      .join(""),
  );
}

it("records a standing rule by phrase when no reviewer model reads the prompts", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "feature/rules-phrase");
  await recordPrompts(RULE_PROMPT);
  await run.cli("01-feature", ["feature", GOAL]);
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await run.cli("03-rules", ["rules"]);
});

it("records a standing rule through MCP", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "feature/rules-mcp");
  await recordPrompts(RULE_PROMPT);
  await run.mcp("01-feature", "visp_feature", { goal: GOAL });
});

it("reads rules and recalls earlier requests with the reviewer's model", async () => {
  project = await GoldenProject.create(CODEX);
  await models.plan({
    tester: DECLINED_TESTER,
    rules: [{ rule: "Never log request bodies.", quote: "never log request bodies" }],
    memory: [1],
  });
  const run = new Recorder(project, "feature/models");
  await recordPrompts(
    "Values in this project are whole numbers from 0 to 9. Make the module export the value one.",
  );
  await run.cli("01-feature-first", ["feature", "Export the value one"]);
  await run.models("01-feature-first", models);
  await project.workspace.write("src/limits.mjs", "export const MAX = 9;\n");
  project.laterCommit("Add the value limit");
  await recordPrompts(
    "Values in this project are whole numbers from 0 to 9. Make the module export the value one.",
    RULE_PROMPT,
  );
  await run.cli("02-feature-recalled", ["feature", GOAL]);
  await run.models("02-feature-recalled", models);
  await project.writeBrief();
  await run.cli("03-work", ["work"]);
});
