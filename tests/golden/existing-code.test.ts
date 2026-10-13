import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { BRIEF, CLAUDE, CODEX, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * Independent tests of an existing codebase: the Codex tester in execution mode with
 * `critic.existingCodeTests: true`, and why the Claude tester declines.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const TWO = testerSuite([["value is two", "value === 2"]]);
/** Enough source files that VISP treats the project as an existing codebase. */
const EXISTING = {
  "src/format.mjs": "export const format = (value) => String(value);\n",
  "src/parse.mjs": "export const parse = (text) => Number(text);\n",
};

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("says why the Claude tester does not test an existing codebase", async () => {
  project = await GoldenProject.create({
    ...CLAUDE,
    critic: { ...CLAUDE.critic, existingCodeTests: true },
    files: EXISTING,
  });
  await models.plan({ tester: TWO });
  const run = new Recorder(project, "claude/existing-code");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await project.writeBrief(BRIEF);
  await run.cli("02-work", ["work"]);
});

it("runs the Codex tester in execution mode on an existing codebase", async () => {
  project = await GoldenProject.create({
    ...CODEX,
    critic: { ...CODEX.critic, existingCodeTests: true },
    files: EXISTING,
  });
  await models.plan({ tester: TWO });
  const run = new Recorder(project, "codex/existing-code");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await run.models("01-feature", models);
  await project.writeBrief(BRIEF);
  await run.cli("02-work", ["work"]);
});
