import { afterEach, it, vi } from "vitest";
import { FakeModels, testerSuite } from "./support/fake-models.js";
import { CODEX, GOAL, GoldenProject, Recorder, REQUEST } from "./support/project.js";

/**
 * A pinned acceptance test that contradicts the request: the worker disputes it in `visp done`
 * and VISP's reviewer rules on it. One rejected and one upheld ruling.
 */
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1", family: 4 }) }));
const models = FakeModels.install();
const SUITE = testerSuite([
  ["value is two", "value === 2"],
  ["value is odd", "value % 2 === 1"],
]);
const DISPUTE = ["--dispute", "value is odd", "--reason", "The request says return two; two is even"];

let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("waives a disputed pinned test the reviewer upholds", async () => {
  project = await GoldenProject.create(CODEX);
  await models.plan({ tester: SUITE, reviews: ["satisfied"], ruling: "upheld" });
  const run = new Recorder(project, "reviewer/dispute-upheld");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.cli("03-done-pinned-failing", ["done"]);
  await run.cli("04-next-pinned-failing", ["next"]);
  await run.cli("05-done-dispute", ["done", ...DISPUTE]);
  await run.models("05-done-dispute", models);
  await run.cli("06-next", ["next"]);
  await run.cli("07-accept", ["accept"]);
  await run.cli("08-pr", ["pr"]);
});

it("keeps a disputed pinned test the reviewer rejects", async () => {
  project = await GoldenProject.create(CODEX);
  await models.plan({ tester: SUITE, reviews: ["satisfied"], ruling: "rejected" });
  const run = new Recorder(project, "reviewer/dispute-rejected");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await models.clear();
  await project.writeBrief();
  await run.cli("02-work", ["work"]);
  await project.setValue(2);
  await run.mcp("03-done-dispute", "visp_done", {
    dispute: ["value is odd"],
    reason: "The request says return two; two is even",
  });
  await run.models("03-done-dispute", models);
  await run.cli("04-next", ["next"]);
  await run.cli("05-done-dispute-again", ["done", ...DISPUTE]);
  await run.cli("06-next", ["next"]);
});
