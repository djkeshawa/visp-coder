import { afterEach, it } from "vitest";
import { BRIEF, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/** The reviewer-off product loop through the MCP tools a host's model calls. */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("walks the same loop through MCP tools", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "loop/mcp");
  await run.mcp("01-feature", "visp_feature", { goal: GOAL, sourceBrief: REQUEST });
  await run.mcp("02-brief-patch", "visp_brief", {
    patch: BRIEF,
    reason: "Define the first usable behavior",
  });
  await run.mcp("03-work-first", "visp_work");
  await run.mcp("04-work-again", "visp_work", { task: "T001" });
  // What the worker is told before a write: the same decision the edit hook makes.
  await run.mcp("04a-guard-in-scope", "visp_guard", { paths: ["src/value.mjs"] });
  await run.mcp("04b-guard-out-of-scope", "visp_guard", {
    paths: ["src/value.mjs", "src/other.mjs"],
  });
  await run.mcp("05-done-failing", "visp_done");
  await project.setValue(2);
  await run.mcp("06-done-passing", "visp_done");
  await run.mcp("07-status", "visp_status");
});
