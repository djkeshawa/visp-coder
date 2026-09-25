"""Score benchmark runs with a task's hidden tests.

Usage: score.py <task> <run_name> [<run_name> ...]
Writes hidden.json beside each project and prints one line per run.
"""
import json
import pathlib
import subprocess
import sys

from common import RUNS

BENCH = pathlib.Path(__file__).resolve().parent
task = sys.argv[1]
for name in sys.argv[2:]:
    project = RUNS / "runs" / name / "project"
    out = subprocess.run([sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project)],
                         capture_output=True, text=True, timeout=600)
    (project.parent / "hidden.json").write_text(out.stdout)
    try:
        result = json.loads(out.stdout)
    except ValueError:
        print(f"{name}: no result ({out.stderr[-300:]})")
        continue
    groups = {}
    for r in result["results"]:
        prefix = r["name"].split(":", 1)[0] if r["name"].startswith(("ext:", "new:")) else "core"
        groups.setdefault(prefix, []).append(r)
    failed = [r["name"] for r in result["results"] if not r["passed"]]
    score = " ".join(
        f"{'' if name == 'core' else name + ' '}{sum(r['passed'] for r in rows)}/{len(rows)}"
        for name, rows in groups.items()
    )
    print(f"{name}: {score} failed={failed}")
