"""Prepare one benchmark project and write the actor prompt for it.

Usage: setup_arm.py <task> <arm> <run_name>
arm: bare | speckit | bmad | visp:<build> (Claude Code worker) | visp-codex:<build> (Codex worker)
<build> is a name given to build_visp.sh.

The prompt is host-neutral; run_claude.py or run_codex.py gives it to a headless worker that
works only inside the project. Every arm receives the same task and constraints.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys

from common import RUNS

BENCH = pathlib.Path(__file__).resolve().parent
task_name, arm, name = sys.argv[1:4]
root = RUNS / "runs" / name / "project"
root.mkdir(parents=True, exist_ok=False)
task = (BENCH / "tasks" / task_name / "task.md").read_text()
env = dict(os.environ)
shim_dir = None


def sh(argv):
    r = subprocess.run(argv, cwd=root, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"setup failed: {argv}\n{r.stderr[-2000:]}")


sh(["git", "init", "-q", "-b", "main"])
sh(["git", "config", "user.name", "Bench"])
sh(["git", "config", "user.email", "bench@localhost"])
(root / ".gitignore").write_text("__pycache__/\nnode_modules/\n")
# A brownfield task starts from its existing codebase.
start = BENCH / "tasks" / task_name / "start"
if start.is_dir():
    shutil.copytree(start, root, dirs_exist_ok=True)

COMMON = (
    f"Your project directory is {root}. Run every shell command from that directory "
    f"(start each command with `cd {root} && `) and create or edit files only inside it. "
    "Do not read other directories. No dependency downloads or network APIs; the standard "
    "library is available. Do not ask questions: make reasonable assumptions and continue. "
    "Do not delegate to other agents. Build it, run your tests, and finish with a short report "
    "of what you actually verified."
)
if arm == "bare":
    workflow = "Use ordinary coding: write the code and tests directly."
elif arm == "speckit":
    sh(["specify", "init", "--here", "--force", "--non-interactive", "--integration", "claude"])
    workflow = (
        "This project uses GitHub Spec Kit. Follow its workflow in order by reading each command "
        "under .claude/skills/ named speckit-* and carrying out its instructions exactly as if the "
        "user had invoked it: specify (with the task below as input), then plan, then tasks, then "
        "implement, then converge. Answer any clarification yourself with a reasonable assumption."
    )
elif arm == "bmad":
    sh(["npx", "-y", "bmad-method@6.12.0", "install", "--yes", "--tools", "claude-code",
        "--modules", "bmm", "--directory", "."])
    workflow = (
        "This project uses the BMAD Method. Follow its bmad-build workflow for this request: read "
        "the bmad-build skill under .claude/skills/ and carry out its instructions exactly as if the "
        "user had invoked it, including the workflow files it points to. Where it asks the user for "
        "approval or input, approve your own recommendation and continue until the implementation "
        "is complete and tested."
    )
elif arm.startswith("visp:") or arm.startswith("visp-codex:"):
    # visp-codex installs the Codex instructions for a Codex worker; the reviewer is Codex either way.
    host = "codex" if arm.startswith("visp-codex:") else "claude-code"
    shim = RUNS / "shims" / arm.split(":", 1)[1]
    shim_dir = str(shim)
    env["PATH"] = f"{shim}:{env['PATH']}"
    sh(["visp", "init", "--harness", host, "--json"])
    config = (root / "visp.yml").read_text()
    # The reviewer is a stronger model than the worker.
    config = config.replace("critic:\n  harness: claude-code", "critic:\n  harness: codex\n  launch: codex-exec\n  reasoningEffort: medium\n  webSearch: true")
    (root / "visp.yml").write_text(config)
    sh(["visp", "install", "--harness", host, "--json"])
    guide = "AGENTS.md" if host == "codex" else "CLAUDE.md"
    workflow = (
        f"This project uses VISP. Read {guide} and the VISP instructions it references before "
        f"starting, and follow them. Run every command with `export PATH={shim}:$PATH` first so "
        f"`visp` is the project's build."
    )
else:
    raise SystemExit(f"unknown arm {arm}")

sh(["git", "add", "-A"])
sh(["git", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Benchmark scaffold"])
prompt = f"{workflow}\n\n{COMMON}\n\nTask:\n\n{task}"
(root.parent / "prompt.txt").write_text(prompt)
# The headless runner puts the arm's VISP build on PATH so installed hooks find it.
(root.parent / "arm.json").write_text(json.dumps({"task": task_name, "arm": arm, "shim": shim_dir}))
print(json.dumps({"root": str(root), "prompt": str(root.parent / "prompt.txt")}))
