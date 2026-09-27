"""Run a two-session task: one first session, then the second request under several memory modes.

Usage: run_carryover.py <run_name> [--modes wiped,fresh,oracle] [--model ...] [--timeout 2700]

The run must be prepared by setup_arm.py with a two-session task. The first session runs once;
its project is snapshotted, and every mode restores that snapshot at the same path before its
second session, so the modes are paired on one first session. Modes:

- wiped:  new session; the project keeps its code, tests and README, but everything the
          workflow kept about the first session is reset: .visp/ goes back to its state before
          the first session (no features, prompt log or memory notes), and CLAUDE.md and
          AGENTS.md back to the scaffold. Git history is kept; carriers.json records whether
          the first session committed VISP records.
- fresh:  new session on the project exactly as the first session left it.
- oracle: like fresh, with the first session's conventions restated in the request.
- resume: the second request continues the first session's conversation.
- noisy:  like memory, with the store first holding the earlier feature requests in the
          task's noise.md (unrelated features and near-miss traps), recorded as VISP would;
          Visp Memory's keyword selection alone chooses what the request carries.
- gated:  noisy, with the reviewer's model choosing among the candidates.
- memory: like fresh, with Visp Memory as VISP's long-term store (`memory.service`, set up
          before the second session; needs $VISP_BENCH_RUNS/visp-memory-venv and a VISP build
          that supports it).

Writes session1/ (result.json, carriers.json, hidden-stage1.json, snapshot.tar, visp-scaffold.tar) and <mode>/
(result.json, the finished project) under the run. Score each mode with
score.py <task> <run>/<mode> after the batch.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile

from common import RUNS
from run_claude import MODEL, run_session

BENCH = pathlib.Path(__file__).resolve().parent
MODES = ("wiped", "fresh", "oracle", "resume", "memory", "noisy", "gated")
MEMORY = RUNS / "visp-memory-venv" / "bin" / "visp-memory"
NOTES = ("CLAUDE.md", "AGENTS.md")
# Where each first-session convention could have been written down. C1 and C2 are also visible
# in the code the first session wrote; C3 and C4 are not, until the second session needs them.
MARKERS = {
    "C3 money": re.compile(r"Cents"),
    "C4 deletion": re.compile(r"\bgone\b|hard[- ]delet", re.IGNORECASE),
}
SKIP = {".git", "node_modules", "__pycache__", ".pytest_cache"}


def git(project, *argv):
    return subprocess.run(["git", *argv], cwd=project, capture_output=True, text=True).stdout


def mentions(project):
    """Count each convention's markers per file, outside version control and caches."""
    counts = {}
    for path in sorted(project.rglob("*")):
        if not path.is_file() or SKIP.intersection(path.relative_to(project).parts):
            continue
        try:
            text = path.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for name, pattern in MARKERS.items():
            counts[name, str(path.relative_to(project))] = len(pattern.findall(text))
    return counts


def carriers(before, after):
    """Files where the first session added mentions of a convention the code does not yet show."""
    found = {name: [] for name in MARKERS}
    for (name, path), count in after.items():
        if count > before.get((name, path), 0):
            found[name].append(path)
    return found


def restore(project, snapshot):
    shutil.rmtree(project)
    project.mkdir()
    with tarfile.open(snapshot) as archive:
        archive.extractall(project)


def wipe_notes(project, workflow_state):
    """Reset what the workflow kept about earlier sessions, keeping code, tests and README."""
    shutil.rmtree(project / ".visp", ignore_errors=True)
    if workflow_state.is_file():
        with tarfile.open(workflow_state) as archive:
            archive.extractall(project)
    scaffold = git(project, "rev-list", "--max-parents=0", "HEAD").strip()
    for name in NOTES:
        original = subprocess.run(["git", "show", f"{scaffold}:{name}"], cwd=project,
                                  capture_output=True, text=True)
        if original.returncode == 0:
            (project / name).write_text(original.stdout)
        else:
            (project / name).unlink(missing_ok=True)


def enable_memory(project, select="model"):
    """Visp Memory with its defaults (SQLite, keyword recall); only its own files are committed."""
    subprocess.run([str(MEMORY), "init", "--no-mine"], cwd=project, check=True, capture_output=True)
    config = (project / "visp.yml").read_text()
    (project / "visp.yml").write_text(
        config.replace("memory:\n", f"memory:\n  service:\n    command: {MEMORY}\n    select: {select}\n", 1))
    git(project, "add", "visp.yml", ".gitignore", "visp-memory.yaml")
    git(project, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "Enable Visp Memory")


def request_chunks(request):
    """Paragraphs and list items, as VISP records a request (src/memory/memory-service.ts)."""
    chunks = []
    for block in re.split(r"\n\s*\n", request):
        items = [line.strip() for line in block.split("\n") if re.match(r"^\s*(?:[-*•]|\d+[.)])\s+\S", line)]
        chunks += items or [re.sub(r"\s+", " ", block).strip()]
    return [chunk[:1000] for chunk in chunks if len(chunk) >= 20]


def seed_noise(project, task):
    """Earlier feature requests, recorded in Visp Memory the way VISP records them."""
    noise = (BENCH / "tasks" / task / "noise.md").read_text()
    for index, request in enumerate(noise.split("\n---\n"), start=1):
        goal = request.strip().splitlines()[0].removeprefix("Feature:").strip()
        body = request.strip().split("\n", 1)[1]
        for chunk in request_chunks(body):
            subprocess.run([str(MEMORY), "decision", chunk, f"Stated by the user for feature n{index:02d}: {goal}"],
                           cwd=project, check=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--modes", default="wiped,fresh,oracle")
    parser.add_argument("--model", default=MODEL)
    parser.add_argument("--timeout", type=int, default=2700)
    args = parser.parse_args()
    modes = args.modes.split(",")
    unknown = set(modes) - set(MODES)
    if unknown:
        raise SystemExit(f"unknown modes: {sorted(unknown)}")

    # Visp Memory without an embedding provider; only the memory mode calls it.
    os.environ.setdefault("VISP_MEMORY_EMBEDDING_PROVIDER", "noop")
    run = RUNS / "runs" / args.run
    project = run / "project"
    arm = json.loads((run / "arm.json").read_text())
    first = run / "session1"
    first.mkdir(exist_ok=False)

    before = mentions(project)
    # The workflow's own state before the first session, restored by the wiped mode.
    workflow_state = first / "visp-scaffold.tar"
    if (project / ".visp").is_dir():
        with tarfile.open(workflow_state, "w") as archive:
            archive.add(project / ".visp", arcname=".visp")
    result = run_session(project, arm, (run / "prompt.txt").read_text(), args.model, args.timeout)
    (first / "result.json").write_text(json.dumps({"run": args.run, "session": 1, **result}, indent=2))
    carried = carriers(before, mentions(project))
    carried["committed VISP records"] = sorted(set(
        git(project, "log", "--format=", "--name-only", "--", ".visp/features", ".visp/memory").split()))
    (first / "carriers.json").write_text(json.dumps(carried, indent=2))
    scored = subprocess.run([sys.executable, str(BENCH / "tasks" / arm["task"] / "hidden_test.py"),
                             str(project), "--stage", "1"], capture_output=True, text=True, timeout=600)
    (first / "hidden-stage1.json").write_text(scored.stdout)
    try:
        stage1 = json.loads(scored.stdout)
        stage1 = f"{stage1['passed']}/{stage1['total']}"
    except (ValueError, KeyError):
        stage1 = "no result"
    snapshot = first / "snapshot.tar"
    with tarfile.open(snapshot, "w") as archive:
        for path in project.iterdir():
            archive.add(path, arcname=path.name)
    print(json.dumps({"run": args.run, "session": 1, "seconds": result["seconds"],
                      "timedOut": result["timedOut"], "stage1": stage1, "carriers": carried}))

    for mode in modes:
        restore(project, snapshot)
        if mode == "wiped":
            wipe_notes(project, workflow_state)
        if mode in ("memory", "noisy", "gated"):
            enable_memory(project, "keyword" if mode == "noisy" else "model")
        if mode in ("noisy", "gated"):
            seed_noise(project, arm["task"])
        prompt = (run / ("prompt2-oracle.txt" if mode == "oracle" else "prompt2.txt")).read_text()
        resume = result["sessionId"] if mode == "resume" else None
        if mode == "resume" and not resume:
            print(json.dumps({"run": args.run, "mode": mode, "skipped": "first session has no id"}))
            continue
        second = run_session(project, arm, prompt, args.model, args.timeout, resume)
        out = run / mode
        out.mkdir()
        (out / "result.json").write_text(json.dumps({"run": args.run, "mode": mode, **second}, indent=2))
        shutil.move(str(project), out / "project")
        project.mkdir()
        print(json.dumps({"run": args.run, "mode": mode, "seconds": second["seconds"],
                          "timedOut": second["timedOut"], "isError": second["isError"]}))
    project.rmdir()


if __name__ == "__main__":
    main()
