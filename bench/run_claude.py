"""Run one prepared arm with a headless Claude Code actor in its project directory.

Usage: run_claude.py <run_name> [--model claude-haiku-4-5-20251001] [--timeout 2700]

Unlike a subagent, a headless session started in the project loads the project's own
CLAUDE.md, skills and hooks, so each workflow is enforced the way a user would run it.
User-level settings and MCP servers are excluded so every arm starts from the same host.
Writes result.json (duration, turns, cost, tokens) beside the project.
"""
import argparse
import json
import os
import pathlib
import subprocess
import time

from common import RUNS

parser = argparse.ArgumentParser()
parser.add_argument("run")
parser.add_argument("--model", default="claude-haiku-4-5-20251001")
parser.add_argument("--timeout", type=int, default=2700)
args = parser.parse_args()

run = RUNS / "runs" / args.run
project = run / "project"
arm = json.loads((run / "arm.json").read_text())
env = dict(os.environ)
if arm.get("shim"):
    env["PATH"] = f"{arm['shim']}:{env['PATH']}"
# Spec Kit is driven one command per user turn; each skill ends by naming the next one
# and waits. Its later phases are sent as follow-ups in the same session.
FOLLOW_UPS = {
    "speckit": [f"Continue: carry out the speckit-{phase} skill now, then stop."
                for phase in ("plan", "tasks", "implement", "converge")],
}


def turn(prompt, session=None):
    argv = ["claude", "-p", prompt, "--model", args.model, "--output-format", "json",
            "--permission-mode", "bypassPermissions", "--setting-sources", "project,local",
            "--strict-mcp-config"]
    if session:
        argv += ["--resume", session]
    remaining = max(60, args.timeout - int(time.time() - started))
    try:
        completed = subprocess.run(argv, cwd=project, env=env, capture_output=True, text=True,
                                   timeout=remaining)
        return json.loads(completed.stdout), False
    except subprocess.TimeoutExpired:
        return {}, True
    except ValueError:
        return {"raw": completed.stdout[-2000:]}, False


started = time.time()
data, timed_out = turn((run / "prompt.txt").read_text())
turns = [data]
for follow_up in FOLLOW_UPS.get(arm["arm"], []):
    if timed_out or not data.get("session_id"):
        break
    data, timed_out = turn(follow_up, data["session_id"])
    turns.append(data)
# BMAD's workflow can end its turn asking the user to approve the spec; answer as a user would.
for _ in range(3):
    if arm["arm"] != "bmad" or timed_out or not data.get("session_id"):
        break
    if "approve and continue" not in str(data.get("result", "")).lower():
        break
    data, timed_out = turn("Approve and continue.", data["session_id"])
    turns.append(data)
elapsed = round(time.time() - started)


def total(key):
    values = [(entry.get("usage") or {}).get(key) for entry in turns]
    return sum(value for value in values if isinstance(value, int)) or None


result = {
    "run": args.run, "arm": arm["arm"], "model": args.model, "seconds": elapsed, "timedOut": timed_out,
    "turns": sum(entry.get("num_turns") or 0 for entry in turns), "userTurns": len(turns),
    "isError": any(entry.get("is_error") for entry in turns),
    "inputTokens": total("input_tokens"), "cacheReadTokens": total("cache_read_input_tokens"),
    "cacheWriteTokens": total("cache_creation_input_tokens"), "outputTokens": total("output_tokens"),
    "report": str(data.get("result", ""))[-1500:],
}
(run / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps({k: result[k] for k in ("run", "arm", "seconds", "timedOut", "turns", "isError")}))
