import { afterEach, it } from "vitest";
import { runHook, SESSION } from "./support/hooks.js";
import { BRIEF, GoldenProject, Recorder } from "./support/project.js";

/**
 * A check that cannot run (its executable is missing): an environment failure, not a product
 * failure. What done, next and the Stop hook tell the worker.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("reports a check that cannot run as an environment step", async () => {
  project = await GoldenProject.create({ harness: "claude-code" });
  const run = new Recorder(project, "environment/missing-command");
  await project.startFeature({
    ...BRIEF,
    checks: [{ ...BRIEF.checks[0], command: ["golden-missing-tool", "--check"] }],
  });
  await run.cli("01-work", ["work"]);
  await run.cli("02-done", ["done"]);
  await run.cli("03-next", ["next"]);
  await run.mcp("03-next", "visp_next");
  await run.save(
    "04-stop-hook.txt",
    runHook(
      project.root,
      ".visp/hooks/claude-pretooluse.mjs",
      { session_id: SESSION, hook_event_name: "Stop" },
      { CLAUDE_PROJECT_DIR: project.root },
    ),
  );
});
