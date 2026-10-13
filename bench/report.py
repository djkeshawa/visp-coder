"""Report a batch: facts per run and per task x arm, and the base-versus-candidate quality rule.

Usage: report.py --batch <name> [--score] [--score-jobs 3] [--base LABEL] [--runs] [--md FILE] [--json FILE]

Reads $VISP_BENCH_RUNS/batches/<name>/manifest.json (batch.py). Refuses a batch whose runs were
made under different presets, or whose worker model differs from the preset's. Runs a usage
limit stopped are marked invalid, excluded from every number and listed, with any invalid runs a
rerun moved to discarded/. --score first runs score.py (hidden checks), judge.py (visual tasks and
games) and code_judge.py (every task but the visual ones) for finished valid runs missing them.

Per run: hidden pass rate, judge overall and checklist passes, code-quality overall, wall time,
the worker's time split (runfacts.py: model, visp, own commands, idle, and the Oct 13 legacy
idle), VISP reviews run and unavailable, pictures delivered to the reviewer, hook refusals and
timeouts. Per task x arm: means of the scores, medians of the times, sums of the counts.

Paired comparison: the first arm in the manifest (or --base) against each other arm, per task.
The candidate passes a task when its mean hidden pass rate, mean judge score, mean checklist
passes and mean code-quality score are each no lower than the base's (where the task has them),
and its median wall time and median idle time are at most 15% above the base's (idle also may
exceed a base under 60 s by up to 60 s, so a few seconds of waiting against none is not a
failure). It passes the batch when it passes every task with valid runs on both sides.
Prints Markdown and writes JSON (default batches/<name>/report.json).
"""
import argparse
import collections
import concurrent.futures
import json
import pathlib
import statistics
import subprocess
import sys

from common import RUNS
from judge import CHECKLISTS, GAMES
from runfacts import final_project, invalid, is_finished, mark_if_invalid, sessions, timing, transcripts

BENCH = pathlib.Path(__file__).resolve().parent
SLOWER = 0.15
IDLE_FLOOR = 60


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def hidden_rate(run, entry):
    path = final_project(run).parent / "hidden.json"
    if not (BENCH / "tasks" / entry["task"] / "hidden_test.py").exists():
        return None, None
    result = load(path)
    if not result or not result.get("results"):
        return (0.0, "no result") if path.exists() else (None, None)
    passed = sum(bool(r["passed"]) for r in result["results"])
    return passed / len(result["results"]), f"{passed}/{len(result['results'])}"


def checklist(judged):
    if not judged or judged.get("overall") is None:
        return None, None
    passed = total = 0
    for key in ("elements", "styles"):
        done, count = str(judged.get(key, "0/0")).split("/")
        passed, total = passed + int(done), total + int(count)
    return passed, f"{passed}/{total}"


def reviews(project):
    attempts = collections.Counter()
    for state in project.glob(".visp/features/*/critic/*.json"):
        for attempt in (load(state) or {}).get("attempts", []):
            attempts[attempt.get("status")] += 1
    pictures = 0
    for state in project.glob(".visp/features/*/product-state.json"):
        pictures += sum(1 for capture in (load(state) or {}).get("captures", [])
                        if str(capture.get("route", "")).startswith("result image: "))
    return attempts["reviewed"], attempts["unavailable"], pictures


def facts(entry):
    run = RUNS / "runs" / entry["name"]
    results = [load(path) or {} for _, path in sessions(run)]
    project = final_project(run)
    rate, hidden = hidden_rate(run, entry)
    judged = load(run / "judge.json")
    passes, passes_text = checklist(judged)
    code = load(project.parent / "code_judge.json")
    reviewed, unavailable, pictures = reviews(project)
    split = timing(transcripts(run))
    stage1 = load(run / "session1" / "hidden-stage1.json") if entry["twoSessions"] else None
    return {
        "run": entry["name"], "task": entry["task"], "arm": entry["label"], "rep": entry["rep"],
        "hidden": rate, "hiddenText": hidden,
        "stage1": f"{stage1['passed']}/{stage1['total']}" if stage1 and "passed" in stage1 else None,
        "judge": (judged or {}).get("overall"), "checklist": passes, "checklistText": passes_text,
        "code": (code or {}).get("overall"), "codeCriteria": (code or {}).get("criteria"),
        "wall": sum(r.get("seconds") or 0 for r in results),
        "timedOut": any(r.get("timedOut") for r in results), "isError": any(r.get("isError") for r in results),
        "idle": split.get("idleSeconds"), "model": split.get("modelSeconds"), "visp": split.get("vispSeconds"),
        "own": split.get("ownCommandSeconds"), "legacyIdle": split.get("legacyIdle"),
        "refusals": split.get("refusals"), "reviewed": reviewed, "unavailable": unavailable, "pictures": pictures,
    }


def check_presets(manifest, entries):
    wrong = []
    worker = manifest["settings"]["worker"]["model"]
    for entry in entries:
        run = RUNS / "runs" / entry["name"]
        arm = load(run / "arm.json") or {}
        if arm.get("preset") != manifest["preset"]:
            wrong.append(f"{entry['name']}: arm.json preset {arm.get('preset')!r}")
        for label, path in sessions(run):
            result = load(path) or {}
            if result.get("preset") != manifest["preset"]:
                wrong.append(f"{entry['name']} {label}: result.json preset {result.get('preset')!r}")
            if not entry["arm"].startswith("visp-codex:") and result.get("model") != worker:
                wrong.append(f"{entry['name']} {label}: worker {result.get('model')!r}, preset worker {worker!r}")
    if wrong:
        raise SystemExit(f"refusing to report batch {manifest['batch']}: runs are not all preset "
                         f"{manifest['preset']}:\n" + "\n".join(wrong))


def score_missing(entries, jobs):
    def score(entry):
        run = RUNS / "runs" / entry["name"]
        project = final_project(run)
        name = entry["name"] + (f"/{project.parent.name}" if project.parent != run else "")
        steps = []
        if (BENCH / "tasks" / entry["task"] / "hidden_test.py").exists() and not (project.parent / "hidden.json").exists():
            steps.append(["score.py", entry["task"], name])
        if entry["task"] in CHECKLISTS and not (run / "judge.json").exists():
            steps.append(["judge.py", entry["name"]])
        if (entry["task"] not in CHECKLISTS or entry["task"] in GAMES) and not (project.parent / "code_judge.json").exists():
            steps.append(["code_judge.py", entry["name"]])
        for step in steps:
            done = subprocess.run([sys.executable, str(BENCH / step[0]), *step[1:]], capture_output=True, text=True)
            print(f"{step[0]} {entry['name']}: {(done.stdout or done.stderr).strip()[-300:]}", file=sys.stderr)

    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        list(pool.map(score, entries))


def mean(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.mean(values), 3) if values else None


def median(values):
    values = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.median(values), 1) if values else None


def summarize(rows):
    return {
        "n": len(rows), "hidden": mean(r["hidden"] for r in rows), "judge": mean(r["judge"] for r in rows),
        "checklist": mean(r["checklist"] for r in rows), "code": mean(r["code"] for r in rows),
        "wall": median(r["wall"] for r in rows), "idle": median(r["idle"] for r in rows),
        "model": median(r["model"] for r in rows), "visp": median(r["visp"] for r in rows),
        "own": median(r["own"] for r in rows), "legacyIdle": median(r["legacyIdle"] for r in rows),
        "reviewed": sum(r["reviewed"] for r in rows), "unavailable": sum(r["unavailable"] for r in rows),
        "pictures": sum(r["pictures"] for r in rows), "refusals": sum(r["refusals"] or 0 for r in rows),
        "timeouts": sum(r["timedOut"] for r in rows),
    }


def compare(base, cand):
    """Rule checks for one task: (metric, base, candidate, delta, rule, passed) rows."""
    checks = []
    for metric in ("hidden", "judge", "checklist", "code"):
        if base[metric] is None and cand[metric] is None:
            continue
        ok = base[metric] is not None and cand[metric] is not None and cand[metric] >= base[metric] - 1e-9
        delta = None if None in (base[metric], cand[metric]) else round(cand[metric] - base[metric], 3)
        checks.append((metric, base[metric], cand[metric], delta, "no drop", ok))
    for metric in ("wall", "idle"):
        if base[metric] is None or cand[metric] is None:
            checks.append((metric, base[metric], cand[metric], None, "at most +15%", False))
            continue
        limit = base[metric] * (1 + SLOWER)
        if metric == "idle" and base[metric] < IDLE_FLOOR:
            limit = max(limit, base[metric] + IDLE_FLOOR)
        checks.append((metric, base[metric], cand[metric], round(cand[metric] - base[metric], 1),
                       "at most +15%", cand[metric] <= limit))
    return checks


def fmt(value, metric=None):
    if value is None:
        return "–"
    if metric == "hidden":
        return f"{value * 100:.1f}%"
    return f"{value:g}" if isinstance(value, (int, float)) else str(value)


def markdown(manifest, rows, groups, comparisons, excluded, show_runs):
    out = [f"## Batch {manifest['batch']} (preset {manifest['preset']})", ""]
    worker = manifest["settings"]["worker"]
    out.append(f"Worker {worker['model']} ({worker['effort'] or 'default effort'}); "
               f"{len(rows)} valid runs; {len(excluded)} invalid runs excluded.")
    out += ["", "| Task | Arm | n | Hidden | Judge | Checklist | Code | Wall s | Idle s | Model s | VISP s | Own s "
            "| Legacy idle s | Reviews run/unavailable | Pictures | Refusals | Timeouts |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for (task, arm), summary in groups.items():
        s = summary
        out.append(f"| {task} | {arm} | {s['n']} | {fmt(s['hidden'], 'hidden')} | {fmt(s['judge'])} | "
                   f"{fmt(s['checklist'])} | {fmt(s['code'])} | {fmt(s['wall'])} | {fmt(s['idle'])} | "
                   f"{fmt(s['model'])} | {fmt(s['visp'])} | {fmt(s['own'])} | {fmt(s['legacyIdle'])} | "
                   f"{s['reviewed']}/{s['unavailable']} | {s['pictures']} | {s['refusals']} | {s['timeouts']} |")
    out.append("")
    out.append("Scores are means over valid runs; times are medians (wall: all sessions; idle, model, VISP and own "
               "from the worker transcript; legacy idle: gaps over 240 s).")
    for cand, result in comparisons.items():
        out += ["", f"### {cand} against {result['base']}: {'PASS' if result['passed'] else 'FAIL'}", "",
                "| Task | Metric | Base | Candidate | Delta | Rule | Result |", "| --- | --- | --- | --- | --- | --- | --- |"]
        for task, checks in result["tasks"].items():
            if not checks:
                out.append(f"| {task} | – | – | – | – | valid runs on both sides | incomplete |")
            for metric, base, value, delta, rule, ok in checks:
                out.append(f"| {task} | {metric} | {fmt(base, metric)} | {fmt(value, metric)} | "
                           f"{fmt(delta * 100 if metric == 'hidden' and delta is not None else delta)}"
                           f"{' pp' if metric == 'hidden' and delta is not None else ''} | {rule} | "
                           f"{'pass' if ok else 'FAIL'} |")
    if excluded:
        out += ["", "Invalid runs (usage limit), excluded:", ""]
        out += [f"- {name}: {reason}" for name, reason in excluded]
    if show_runs:
        out += ["", "| Run | Hidden | Stage 1 | Judge | Checklist | Code | Wall s | Idle s | Model s | VISP s | Own s "
                "| Legacy idle s | Reviews | Pictures | Refusals | Timed out |",
                "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in rows:
            out.append(f"| {r['run']} | {r['hiddenText'] or '–'} | {r['stage1'] or '–'} | {fmt(r['judge'])} | "
                       f"{r['checklistText'] or '–'} | {fmt(r['code'])} | {r['wall']} | {fmt(r['idle'])} | "
                       f"{fmt(r['model'])} | {fmt(r['visp'])} | {fmt(r['own'])} | {fmt(r['legacyIdle'])} | "
                       f"{r['reviewed']}/{r['unavailable']} | {r['pictures']} | {fmt(r['refusals'])} | "
                       f"{'yes' if r['timedOut'] else 'no'} |")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", required=True)
    parser.add_argument("--score", action="store_true")
    parser.add_argument("--score-jobs", type=int, default=3)
    parser.add_argument("--base", help="the base arm label (default: the first arm in the manifest)")
    parser.add_argument("--runs", action="store_true", help="also print one row per run")
    parser.add_argument("--md", type=pathlib.Path)
    parser.add_argument("--json", type=pathlib.Path)
    args = parser.parse_args()
    directory = RUNS / "batches" / args.batch
    manifest = load(directory / "manifest.json")
    if not manifest:
        raise SystemExit(f"no manifest at {directory / 'manifest.json'}")
    finished = [entry for entry in manifest["runs"]
                if is_finished(RUNS / "runs" / entry["name"], entry["twoSessions"])]
    check_presets(manifest, finished)
    excluded, valid = [], []
    for entry in finished:
        stopped = mark_if_invalid(RUNS / "runs" / entry["name"])
        if stopped:
            excluded.append((entry["name"], f"{stopped['source']}: {stopped['match'].strip()[:120]}"))
        else:
            valid.append(entry)
    for entry in manifest["runs"]:
        for moved in sorted((RUNS / "discarded").glob(f"{entry['name']}-*-invalid")):
            excluded.append((moved.name, f"moved to discarded/ by --rerun-invalid: {(invalid(moved) or {}).get('source')}"))
    if args.score:
        score_missing(valid, args.score_jobs)
    rows = [facts(entry) for entry in valid]
    labels = [arm["label"] for arm in manifest["arms"]]
    groups = {}
    for task in manifest["tasks"]:
        for label in labels:
            groups[(task, label)] = summarize([r for r in rows if r["task"] == task and r["arm"] == label])
    base = args.base or labels[0]
    comparisons = {}
    for cand in labels:
        if cand == base:
            continue
        tasks = {}
        for task in manifest["tasks"]:
            if groups[(task, base)]["n"] and groups[(task, cand)]["n"]:
                tasks[task] = compare(groups[(task, base)], groups[(task, cand)])
            else:
                tasks[task] = []
        passed = all(checks and all(check[-1] for check in checks) for checks in tasks.values())
        comparisons[cand] = {"base": base, "passed": passed, "tasks": tasks}
    text = markdown(manifest, rows, groups, comparisons, excluded, args.runs)
    print(text)
    if args.md:
        args.md.write_text(text)
    report = {"batch": args.batch, "preset": manifest["preset"], "settings": manifest["settings"], "runs": rows,
              "groups": [{"task": task, "arm": arm, **summary} for (task, arm), summary in groups.items()],
              "comparisons": {cand: {**result, "tasks": {task: [dict(zip(("metric", "base", "candidate", "delta",
                                                                          "rule", "passed"), check))
                                                                  for check in checks]
                                                           for task, checks in result["tasks"].items()}}
                              for cand, result in comparisons.items()},
              "invalid": [{"run": name, "reason": reason} for name, reason in excluded]}
    (args.json or directory / "report.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
