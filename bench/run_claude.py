"""Run one prepared arm with a headless Claude Code actor in its project directory.

Usage: run_claude.py <run_name> [--model claude-haiku-4-5-20251001] [--timeout 2700]

Unlike a subagent, a headless session started in the project loads the project's own
CLAUDE.md, skills and hooks, so each workflow is enforced the way a user would run it.
User-level settings and MCP servers are excluded so every arm starts from the same host.
Writes result.json (duration, turns, cost, tokens, session id) beside the project.
"""
import argparse
import json
import os
import subprocess
import time

from common import RUNS, isolate

MODEL = "claude-haiku-4-5-20251001"
# Spec Kit is driven one command per user turn; each skill ends by naming the next one
# and waits. Its later phases are sent as follow-ups in the same session.
FOLLOW_UPS = {
    "speckit": [f"Continue: carry out the speckit-{phase} skill now, then stop."
                for phase in ("plan", "tasks", "implement", "converge")],
}


def worker_env(arm):
    env = dict(os.environ)
    if arm.get("shim"):
        env["PATH"] = f"{arm['shim']}:{env['PATH']}"
    # Claude Code's own auto memory lives outside the project and would carry knowledge
    # between sessions of one run; only what the workflow keeps in the project may carry.
    env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
    return env


def run_session(project, arm, prompt, model=MODEL, timeout=2700, resume=None):
    """Run one user session (the prompt plus the arm's scripted follow-ups) and summarize it."""
    env = worker_env(arm)
    started = time.time()

    def turn(text, session=None):
        argv = [*isolate(), "claude", "-p", text, "--model", model, "--output-format", "json",
                "--permission-mode", "bypassPermissions", "--setting-sources", "project,local",
                "--strict-mcp-config"]
        if session:
            argv += ["--resume", session]
        remaining = max(60, timeout - int(time.time() - started))
        try:
            # Own session: a worker signalling its shell's process group (`kill %1` without job
            # control) must not reach sibling runs in the same batch.
            completed = subprocess.run(argv, cwd=project, env=env, capture_output=True, text=True,
                                       timeout=remaining, start_new_session=True)
        except subprocess.TimeoutExpired:
            return {}, True
        try:
            return json.loads(completed.stdout), False
        except ValueError:
            data = {"raw": completed.stdout[-2000:]}
            if completed.returncode != 0:
                # claude (or the namespace wrapper) failed before reporting: count it as an error.
                data.update(is_error=True, exit_code=completed.returncode,
                            result=f"exit {completed.returncode}: {completed.stderr[-1500:]}")
            return data, False

    data, timed_out = turn(prompt, resume)
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

    def total(key):
        values = [(entry.get("usage") or {}).get(key) for entry in turns]
        return sum(value for value in values if isinstance(value, int)) or None

    return {
        "arm": arm["arm"], "model": model, "seconds": round(time.time() - started), "timedOut": timed_out,
        "turns": sum(entry.get("num_turns") or 0 for entry in turns), "userTurns": len(turns),
        "isError": any(entry.get("is_error") for entry in turns),
        "sessionId": next((entry["session_id"] for entry in reversed(turns) if entry.get("session_id")), None),
        "inputTokens": total("input_tokens"), "cacheReadTokens": total("cache_read_input_tokens"),
        "cacheWriteTokens": total("cache_creation_input_tokens"), "outputTokens": total("output_tokens"),
        "report": str(data.get("result", ""))[-1500:],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--timeout", type=int, default=2700)
    args = parser.parse_args()
    run = RUNS / "runs" / args.run
    arm = json.loads((run / "arm.json").read_text())
    result = {"run": args.run, **run_session(run / "project", arm, (run / "prompt.txt").read_text(),
                                             args.model, args.timeout)}
    (run / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ("run", "arm", "seconds", "timedOut", "turns", "isError")}))


if __name__ == "__main__":
    main()
