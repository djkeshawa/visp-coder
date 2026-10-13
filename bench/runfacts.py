"""Facts about one benchmark run: its sessions, where the worker's time went, and validity.

A run is RUNS/runs/<name>. A one-session run has result.json and project/ there; a two-session
run made by run_carryover.py has session1/result.json and <mode>/result.json with the finished
project in <mode>/project. The worker's Claude Code transcripts are found under
~/.claude/projects by the path the project had while it ran (always <run>/project).

Time categories, from consecutive transcript events (each gap is counted once, under the event
that ends it):
- modelSeconds: a gap ending in an assistant event (the model generating or thinking).
- vispSeconds: a gap ending in the result of a Bash command that invokes `visp`, or in VISP's
  Stop hook feedback.
- idleSeconds: pure waiting: a gap ending in the result of a command made only of waiting and
  reading (sleep, tail -f, wait, pgrep, poll loops, reading a background task's output file),
  of Monitor, ScheduleWakeup or a task-output tool, or in a background-task notification or a
  scheduled wake-up after the worker's turn had ended.
- ownCommandSeconds: a gap ending in any other tool result (the worker's own commands and edits).
- otherSeconds: the rest (user prompts and non-VISP hook feedback).
- legacyIdle: the Oct 13 measure, the sum of all gaps longer than 240 s, kept for comparison.
"""
import datetime
import json
import pathlib
import re

CLAUDE_PROJECTS = pathlib.Path.home() / ".claude" / "projects"
# Messages Claude Code and the Codex CLI print when an account's usage limit stops them.
LIMIT = re.compile(r"(?:you've|you have) hit your (?:[\w-]+ )?limit|usage limit (?:reached|exceeded)"
                   r"|limit reached[^\n\"]{0,80}resets|limit · resets", re.IGNORECASE)
LEGACY_GAP = 240
WAIT_TOOLS = {"Monitor", "ScheduleWakeup", "BashOutput", "TaskOutput"}
# A command is pure waiting when it waits on something and every step in it is one of these.
WAITISH = {"sleep", "tail", "cat", "wait", "pgrep", "ps", "grep", "egrep", "echo", "printf", "ls", "head",
           "test", "[", "[[", "true", "false", "timeout", "wc", "date", "jq", "inotifywait", "break", "done",
           "fi", "stat", "kill", "cut", "rm", "sort", "uniq", "tr", "sed", "awk", "for", "seq", "in"}
SHELL_PREFIX = {"while", "until", "do", "then", "else", "if", "!", "{", "}", "time", "nohup", "exec",
                "command", "env", "export", "cd"}
WAIT = re.compile(r"\bsleep\s+[\d.]|\btail\b[^;&|\n]*\s(?:-\w*f\w*|--follow)\b|(?:^|[;&|]\s*)wait\b|\bpgrep\b"
                  r"|\binotifywait\b|/tasks/[\w.-]+\.output\b")
SEGMENT = re.compile(r"&&|\|\||[;&|\n()`]|\$\(")
SHELL_C = re.compile(r"\b(?:ba)?sh\s+-l?c\s+(?:'([^']*)'|\"([^\"]*)\")")
REDIRECT = re.compile(r"\d*>&\d+|&>|\d*[<>]+")
QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")


def _steps(command):
    """The first words of each step of a shell command, quoted text removed, `sh -c` unwrapped."""
    command = QUOTED.sub("''", SHELL_C.sub(lambda match: match.group(1) or match.group(2) or "", command))
    command = REDIRECT.sub(" ", command)
    for segment in SEGMENT.split(command):
        words = segment.split()
        while words and (words[0] in SHELL_PREFIX or re.match(r"^\w+=", words[0])):
            words = words[1:]
        if words[:1] == ["timeout"]:
            words = [word for word in words[1:] if not word.startswith("-")][1:]
        if words:
            yield words[0], command


def sessions(run):
    """(label, result path) for each finished session of a run, in order."""
    if (run / "session1").is_dir():
        found = [("session1", run / "session1" / "result.json")]
        found += [(path.parent.name, path) for path in sorted(run.glob("*/result.json"))
                  if path.parent.name != "session1"]
        return [(label, path) for label, path in found if path.is_file()]
    return [("run", run / "result.json")] if (run / "result.json").is_file() else []


def final_project(run):
    """The finished project: <run>/project, or the second session's for a two-session run."""
    seconds = [path.parent for label, path in sessions(run) if label not in ("run", "session1")]
    return seconds[0] / "project" if seconds else run / "project"


def is_finished(run, two_sessions=False):
    if two_sessions:
        return any(label != "session1" for label, _ in sessions(run))
    return (run / "result.json").is_file()


def project_key(path):
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def transcripts(run):
    """The worker's transcripts for this run, written since the run was set up."""
    started = (run / "arm.json").stat().st_mtime - 5 if (run / "arm.json").exists() else 0
    found = {path for path in (CLAUDE_PROJECTS / project_key((run / "project").resolve())).glob("*.jsonl")
             if path.stat().st_mtime >= started}
    for _, result in sessions(run):
        session = json.loads(result.read_text()).get("sessionId")
        if session:
            found.update(CLAUDE_PROJECTS.glob(f"*/{session}.jsonl"))
    return sorted(found, key=lambda path: path.stat().st_mtime)


def _events(path):
    for line in open(path, errors="replace"):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") in ("user", "assistant") and event.get("timestamp") and not event.get("isSidechain"):
            event["_at"] = datetime.datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
            yield event


def _blocks(event):
    content = (event.get("message") or {}).get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return content if isinstance(content, list) else []


def invokes_visp(command):
    return any(word == "visp" or word.endswith("/visp") for word, _ in _steps(command))


def pure_wait(command):
    steps = list(_steps(command))
    if not steps or not WAIT.search(steps[0][1]):
        return False
    return all(word in WAITISH for word, _ in steps)


def tool_category(tool):
    name, payload = tool.get("name"), tool.get("input") or {}
    if name in WAIT_TOOLS:
        return "idle"
    if name == "Read" and re.search(r"/tasks/[\w.-]+\.output$", str(payload.get("file_path", ""))):
        return "idle"
    if name == "Bash":
        command = str(payload.get("command", ""))
        if invokes_visp(command):
            return "visp"
        if pure_wait(command):
            return "idle"
    return "ownCommand"


def user_category(event, tools):
    texts = []
    for block in _blocks(event):
        if block.get("type") == "tool_result":
            return tool_category(tools.get(block.get("tool_use_id"), {}))
        if block.get("type") == "text":
            texts.append(block.get("text", ""))
    text = "\n".join(texts).lstrip()
    if text.startswith(("<task-notification>", "# Autonomous loop check")):
        return "idle"
    if text.startswith("Stop hook feedback") and "VISP" in text:
        return "visp"
    return "other"


def timing(paths):
    """Seconds per category over the given transcripts, plus legacy idle and hook refusals."""
    totals = {key: 0.0 for key in ("model", "visp", "ownCommand", "idle", "other")}
    legacy, refusals = 0.0, 0
    for path in paths:
        refusals += open(path, errors="replace").read().count("in the foreground: repeat this call")
        events = sorted(_events(path), key=lambda event: event["_at"])
        tools = {}
        for previous, event in zip(events, events[1:]):
            for block in _blocks(previous):
                if block.get("type") == "tool_use":
                    tools[block.get("id")] = block
            gap = (event["_at"] - previous["_at"]).total_seconds()
            if gap > LEGACY_GAP:
                legacy += gap
            category = "model" if event["type"] == "assistant" else user_category(event, tools)
            totals[category] += gap
    if not paths:
        return {}
    return {**{f"{key}Seconds": round(value) for key, value in totals.items()},
            "legacyIdle": round(legacy), "refusals": refusals}


def _limit_in(text, source):
    match = LIMIT.search(text)
    if not match:
        return None
    start = max(0, match.start() - 80)
    return {"reason": "usage limit", "source": source, "match": text[start:match.end() + 80]}


def usage_limit(run):
    """The first sign that a usage limit cut the run short, or None.

    Searched: each session's result.json (report and raw output), the worker transcripts'
    messages and tool results (a VISP reviewer stopped by the limit shows there), and VISP's
    reviewer and tester logs in the finished project.
    """
    for label, path in sessions(run):
        result = json.loads(path.read_text())
        found = _limit_in(" ".join(str(result.get(key, "")) for key in ("report", "raw", "result")),
                          f"{label} result.json")
        if found:
            return found
    for path in transcripts(run):
        for event in _events(path):
            for block in _blocks(event):
                text = block.get("text") or block.get("content")
                found = _limit_in(text if isinstance(text, str) else json.dumps(text), f"transcript {path.name}")
                if found:
                    return found
    project = final_project(run)
    for path in [*project.glob(".visp/features/*/*.log"), *project.glob(".visp/features/*/critic/requests/*/*.json")]:
        found = _limit_in(path.read_text(errors="replace"), str(path.relative_to(project)))
        if found:
            return found
    return None


def invalid(run):
    """The recorded reason a run is invalid (invalid.json, which may also be made by hand), or None."""
    path = run / "invalid.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        return {"reason": "marked invalid by hand", "source": str(path), "match": ""}


def mark_if_invalid(run):
    """Record and return a usage-limit stop, so the run is never scored."""
    found = invalid(run) or usage_limit(run)
    if found and not (run / "invalid.json").exists():
        (run / "invalid.json").write_text(json.dumps(found, indent=2))
    return found
