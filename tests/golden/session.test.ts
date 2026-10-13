import { afterEach, it } from "vitest";
import { GoldenProject, Recorder } from "./support/project.js";

/**
 * A slice authorized in an earlier host session, and a new session whose user asked for
 * something else: `visp next` sends the new request to a feature of its own.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

const hostSession = (session: string) =>
  project?.workspace.write(".visp/session/host-session.json", JSON.stringify({ session }));

it("points a later session's new request to visp feature", async () => {
  project = await GoldenProject.create();
  const run = new Recorder(project, "session/lapsed");
  await project.startFeature();
  await hostSession("session-1");
  await run.cli("01-work-session-1", ["work"]);
  await hostSession("session-2");
  await project.workspace.write(
    ".visp/session/user-prompts.jsonl",
    `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", prompt: "Also export the value three." })}\n`,
  );
  await run.cli("02-next-new-session", ["next"]);
  await run.mcp("02-next-new-session", "visp_next");
  await run.cli("03-work-new-session", ["work", "--check", "node checks/value.check.mjs"]);
  await run.cli("04-next-named-task", ["next", "--task", "T001"]);
  await run.cli("05-work-named-task", ["work", "--task", "T001"]);
});
