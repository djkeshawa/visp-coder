import { afterEach, it } from "vitest";
import { BRIEF, GOAL, GoldenProject, REQUEST, Recorder } from "./support/project.js";

/**
 * The product loop with VISP's reviewer off, as a worker drives it: every state `visp next`
 * reaches before review, and the replies of feature, brief, work, done, accept and pr.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("walks feature, brief, work and done through the CLI", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "loop/cli");
  await run.cli("01-next-no-feature", ["next"]);
  await run.mcp("01-next-no-feature", "visp_next");
  await run.cli("02-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await run.cli("03-next-no-slices", ["next"]);
  await run.cli("04-brief-template", ["brief", "--template"]);
  await run.mcp("04-brief-template", "visp_brief", { template: true });

  await project.workspace.write(
    ".visp/drafts/incomplete.json",
    JSON.stringify({
      incomplete: true,
      uncertainties: ["Should the value stay a number, or may it become the string two?"],
    }),
  );
  await run.cli("05-brief-patch-incomplete", [
    "brief",
    "--patch",
    ".visp/drafts/incomplete.json",
    "--reason",
    "Record an open question",
  ]);
  await run.cli("06-next-brief-incomplete", ["next"]);

  await project.workspace.write(".visp/drafts/brief.json", JSON.stringify(BRIEF));
  await run.cli("07-brief-patch", [
    "brief",
    "--patch",
    ".visp/drafts/brief.json",
    "--reason",
    "Define the first usable behavior",
  ]);
  await run.cli("08-next-slice-ready", ["next"]);
  await run.mcp("08-next-slice-ready", "visp_next");
  await run.cli("09-work-first", ["work"]);
  await run.cli("10-next-authorized", ["next"]);
  await run.cli("11-work-again", ["work", "--task", "T001"]);
  await run.cli("12-work-inspect", ["work", "--inspect"]);
  await run.cli("13-done-failing", ["done"]);
  await run.cli("14-next-checks-failing", ["next"]);
  await run.mcp("14-next-checks-failing", "visp_next");
  await project.setValue(2);
  await run.cli("15-done-passing", ["done"]);
  await run.cli("16-next-review-owed", ["next"]);
  await run.mcp("16-next-review-owed", "visp_next");
  await run.cli("17-review-handoff", ["review", "--handoff"]);
  await run.cli("18-accept-unreviewed", ["accept"]);
  await run.cli("19-status", ["status"]);
  await run.cli("20-brief", ["brief"]);
  await run.cli("21-pr", ["pr"]);
});

it("works the whole request as one slice with work --check", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "loop/light");
  await run.cli("01-feature", ["feature", GOAL, "--source-brief", REQUEST]);
  await run.cli("02-work-check", ["work", "--check", "node checks/value.check.mjs"]);
  await run.cli("03-next", ["next"]);
  await project.setValue(2);
  await run.cli("04-done", ["done"]);
  await run.cli("05-next", ["next"]);
});
