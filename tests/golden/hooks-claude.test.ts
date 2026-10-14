import { join } from "node:path";
import { afterEach, it } from "vitest";
import { runHook, SESSION } from "./support/hooks.js";
import { GoldenProject, Recorder } from "./support/project.js";

/**
 * Claude Code's installed hook script driven with the inputs Claude Code sends: what a worker
 * is told when an edit, a shell command or a stop is refused, sent back or allowed.
 */
let project: GoldenProject | undefined;
afterEach(async () => {
  await project?.destroy();
  project = undefined;
});

it("answers Claude Code's edit, shell, prompt and stop hooks", async () => {
  project = await GoldenProject.create({ harness: "claude-code" });
  const run = new Recorder(project, "hooks/claude-code");
  const script = ".visp/hooks/claude-pretooluse.mjs";
  const env = { CLAUDE_PROJECT_DIR: project.root };
  const claude = (name: string, input: Record<string, unknown>) =>
    run.save(
      `${name}.txt`,
      runHook(project?.root ?? "", script, { session_id: SESSION, ...input }, env),
    );
  const write = (path: string) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: join(project?.root ?? "", path), content: "x" },
  });
  const bash = (command: string) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

  await claude("01-prompt", {
    hook_event_name: "UserPromptSubmit",
    prompt: "Make the public value module return two instead of one.",
  });
  await claude("02-write-no-feature", write("src/value.mjs"));
  await claude("03-stop-no-feature", { hook_event_name: "Stop" });
  await project.startFeature();
  await claude("04-write-before-work", write("src/value.mjs"));
  await project.cli("work");
  await claude("05-write-in-scope", write("src/value.mjs"));
  await claude("06-write-out-of-scope", write("README.md"));
  await claude("07-write-visp-state", write(".visp/features/brief.yaml"));
  await claude("08-write-draft", write(".visp/drafts/brief.json"));
  await claude("09-bash-plain", bash("ls src"));
  await claude("10-bash-delete-state", bash("rm -rf .visp"));
  await claude("11-bash-git-clean", bash("git clean -fd"));
  await project.setValue(3);
  await claude("12-bash-discard-changes", bash("git checkout -- src/value.mjs"));
  await claude("13-stop-work", { hook_event_name: "Stop" });
  await claude("14-stop-work-again", { hook_event_name: "Stop" });
  await claude("15-stop-work-limit", { hook_event_name: "Stop" });
  const background = (command: string) => ({
    ...bash(command),
    tool_input: { command, run_in_background: true },
  });
  await claude("16-bash-background-done", background("visp done 2>&1 | tail -40"));
  await claude(
    "17-bash-loop-status",
    bash("until visp status | grep -q accepted; do sleep 10; done"),
  );
  await claude(
    "18-bash-background-feature",
    background(
      "visp feature --source-brief - <<'REQUEST'\nShow visp status in the footer.\nREQUEST",
    ),
  );
});
