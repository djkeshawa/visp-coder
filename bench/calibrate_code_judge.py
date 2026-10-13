"""Calibrate the code-quality judge on correct references and deliberately degraded variants.

Usage: calibrate_code_judge.py [--reps 2] [--jobs 4] [--out DIR] [--check-oracles] [--cases a,b]

Each case is a project built from bench/reference/: the eight correct references, and variants
that degrade one aspect on purpose (VARIANTS). Every case is judged --reps times with
code_judge.py's judge, so the spread between repetitions estimates the judge's variance. A
reference must score high, and a variant clearly lower than its reference on the criteria its
degradation targets. Results are kept per call in DIR/<case>/judge-<rep>.json and a call is
never repeated when its file exists, so a rerun only prints the table (and spends no budget).
--check-oracles first runs the hidden checks on the cases that have them, to show which
variants stay correct (a quality-only degradation) and which break behaviour.

Prints a Markdown table and the number of judge calls with their tokens and cost, and writes
DIR/calibration.json. DIR defaults to $VISP_BENCH_RUNS/code-judge-calibration.
"""
import argparse
import ast
import builtins
import concurrent.futures
import json
import pathlib
import re
import shutil
import statistics
import subprocess
import sys

from code_judge import CRITERIA, judge_project
from common import RUNS

BENCH = pathlib.Path(__file__).resolve().parent
REFERENCES = {
    "reservations": "reservations-api", "spreadsheet": "spreadsheet-cli", "bundles": "reservations-bundles",
    "spreadsheet-extend": "spreadsheet-extend", "slingshot-game": "slingshot-game",
    "carryover": "conventions-carryover", "archive-carryover": "archive-carryover",
    "sheet-carryover": "sheet-carryover",
}
NAMES = [*CRITERIA, "overall"]


def replace(path, old, new):
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"variant source changed: {old!r} not in {path}")
    path.write_text(text.replace(old, new))


def racy_bugs(project):
    """No lock around the shared store, and three contract bugs."""
    server = project / "server.py"
    # Confirming no longer reduces the item; a changed body replays the first reservation; any TTL >= 1.
    replace(server, '                ITEMS[reservation["sku"]] -= reservation["quantity"]\n', "")
    replace(server, '                    if KEYS[key][0] != canonical:\n'
                    '                        raise Failure(422, "idempotency_mismatch")\n', "")
    replace(server, "not 1 <= ttl <= 3600", "ttl < 1")
    replace(server, "import threading\n", "")
    replace(server, "LOCK = threading.Lock()\n", "")
    lines, out, block = server.read_text().splitlines(keepends=True), [], None
    for line in lines:
        indent = len(line) - len(line.lstrip())
        if line.strip() == "with LOCK:":
            block = indent
            continue
        if block is not None and line.strip() and indent <= block:
            block = None
        out.append(line[4:] if block is not None and line.strip() else line)
    server.write_text("".join(out))


def monolith(project):
    """The same behaviour in one long function with short, generic names (calibration/)."""
    shutil.copytree(BENCH / "calibration" / "reservations-monolith", project, dirs_exist_ok=True)


class Renamer(ast.NodeTransformer):
    """Rename functions, classes, parameters and variables to meaningless names, consistently."""

    def __init__(self, tree):
        keep = set(dir(builtins)) | {"self", "cls"}
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                keep |= {(alias.asname or alias.name).split(".")[0] for alias in node.names}
        methods = {id(item) for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
                   for item in node.body if isinstance(item, ast.FunctionDef)}
        found = []
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and id(node) not in methods:
                found.append(("f", node.name))
            elif isinstance(node, ast.ClassDef):
                found.append(("C", node.name))
            elif isinstance(node, ast.arg):
                found.append(("a", node.arg))
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                found.append(("v", node.id))
            elif isinstance(node, ast.ExceptHandler) and node.name:
                found.append(("v", node.name))
        self.mapping = {}
        for prefix, name in found:
            if name not in keep and name not in self.mapping and not name.startswith("__"):
                self.mapping[name] = f"{prefix}{len(self.mapping) + 1}"
        self.methods = methods

    def visit_Name(self, node):
        node.id = self.mapping.get(node.id, node.id)
        return node

    def visit_arg(self, node):
        node.arg = self.mapping.get(node.arg, node.arg)
        return node

    def visit_FunctionDef(self, node):
        if id(node) not in self.methods:
            node.name = self.mapping.get(node.name, node.name)
        if ast.get_docstring(node):
            node.body = node.body[1:] or [ast.Pass()]
        return self.generic_visit(node)

    def visit_ClassDef(self, node):
        node.name = self.mapping.get(node.name, node.name)
        return self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        if node.name:
            node.name = self.mapping.get(node.name, node.name)
        return self.generic_visit(node)

    def visit_keyword(self, node):
        if node.arg:
            node.arg = self.mapping.get(node.arg, node.arg)
        return self.generic_visit(node)

    def visit_Global(self, node):
        node.names = [self.mapping.get(name, name) for name in node.names]
        return node

    visit_Nonlocal = visit_Global


def obscure_names(project):
    """The same program with meaningless names, no comments and no docstrings."""
    for path in project.glob("*.py"):
        tree = ast.parse(path.read_text())
        tree = Renamer(tree).visit(tree)
        if ast.get_docstring(tree):
            tree.body = tree.body[1:]
        path.write_text(ast.unparse(ast.fix_missing_locations(tree)) + "\n")


TRIVIAL_TESTS = '''import unittest

from inventory import errors, http, store, validation


class ApiTest(unittest.TestCase):
    def test_modules_import(self):
        self.assertIsNotNone(store)
        self.assertIsNotNone(http)

    def test_error_is_an_exception(self):
        self.assertTrue(issubclass(errors.ApiError, Exception))

    def test_validation_has_functions(self):
        self.assertTrue(callable(validation.is_int))

    def test_true(self):
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
'''


def trivial_tests(project):
    """The provided API tests replaced by tests that only import the code."""
    (project / "tests" / "test_api.py").write_text(TRIVIAL_TESTS)


def game_bugs(project):
    """Three contract bugs: double removal, winning needs every block gone, the last bird never loses."""
    game = project / "game.js"
    replace(game, "    if (body.hp <= 0) return;\n    body.hp -= amount;", "    body.hp -= amount;")
    replace(game, "if (!bodies.some(b => b.kind === 'pig')) state = 'won';", "if (bodies.length === 0) state = 'won';")
    replace(game, "    if (birds > 0) {\n      state = 'aiming';", "    if (birds >= 0) {\n      state = 'aiming';")


# variant: (reference, transform, criteria it targets)
VARIANTS = {
    "reservations-racy-bugs": ("reservations", racy_bugs, ["correctness_risks"]),
    "reservations-monolith": ("reservations", monolith, ["structure", "readability", "naming"]),
    "spreadsheet-names": ("spreadsheet", obscure_names, ["naming", "readability"]),
    "bundles-trivial-tests": ("bundles", trivial_tests, ["tests"]),
    "slingshot-bugs": ("slingshot-game", game_bugs, ["correctness_risks"]),
}


def build(case, out):
    reference = VARIANTS[case][0] if case in VARIANTS else case
    project = out / case / "project"
    if project.exists():
        shutil.rmtree(project)
    shutil.copytree(BENCH / "reference" / reference, project, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    # The oracle references say what they are in their first line; no case should.
    for path in project.rglob("*.py"):
        text = path.read_text()
        if text.startswith('"""Reference implementation'):
            path.write_text(text.split("\n", 1)[1])
    if case in VARIANTS:
        VARIANTS[case][1](project)
    return project, REFERENCES[reference]


def check_oracle(case, project, task):
    hidden = BENCH / "tasks" / task / "hidden_test.py"
    if not hidden.exists():
        return None
    done = subprocess.run([sys.executable, str(hidden), str(project)], capture_output=True, text=True, timeout=900)
    try:
        result = json.loads(done.stdout)
        passed = sum(r["passed"] for r in result["results"])
        return f"{passed}/{len(result['results'])}"
    except (ValueError, KeyError):
        return "no result"


def judged(case, rep, out, project, task):
    path = out / case / f"judge-{rep}.json"
    if path.exists():
        return json.loads(path.read_text())
    result = {"case": case, "rep": rep, **judge_project(project, task)}
    path.write_text(json.dumps(result, indent=2))
    return result


def spread(values):
    values = [v for v in values if isinstance(v, (int, float))]
    if not values:
        return "–"
    mean = statistics.mean(values)
    return f"{mean:.1f}" + (f" ({min(values)}–{max(values)})" if max(values) != min(values) else "")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reps", type=int, default=2)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--out", type=pathlib.Path, default=RUNS / "code-judge-calibration")
    parser.add_argument("--cases")
    parser.add_argument("--check-oracles", action="store_true")
    args = parser.parse_args()
    cases = args.cases.split(",") if args.cases else [*REFERENCES, *VARIANTS]
    args.out.mkdir(parents=True, exist_ok=True)
    oracles, built = {}, {}
    # Built once, before any judge reads them: repetitions of a case share one project.
    for case in cases:
        built[case] = build(case, args.out)
        if args.check_oracles:
            oracles[case] = check_oracle(case, *built[case])
            print(f"{case}: hidden checks {oracles[case]}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        futures = [pool.submit(judged, case, rep, args.out, *built[case])
                   for case in cases for rep in range(1, args.reps + 1)]
        results = [future.result() for future in futures]
    by_case = {case: [r for r in results if r["case"] == case] for case in cases}

    def score(result, name):
        return result["overall"] if name == "overall" else result["criteria"].get(name)

    def average(rows, name):
        values = [score(r, name) for r in rows if isinstance(score(r, name), int)]
        return statistics.mean(values) if values else float("nan")

    print("\n| Case | Targets | " + " | ".join(NAMES) + " |")
    print("| --- | --- | " + " | ".join("---" for _ in NAMES) + " |")
    for case, rows in by_case.items():
        targets = ", ".join(VARIANTS[case][2]) if case in VARIANTS else "reference"
        print(f"| {case} | {targets} | " + " | ".join(spread([score(r, n) for r in rows]) for n in NAMES) + " |")
    print("\n| Variant | Criterion | Reference | Variant | Drop |")
    print("| --- | --- | --- | --- | --- |")
    drops = []
    for case, (reference, _, targets) in VARIANTS.items():
        if not by_case.get(case) or not by_case.get(reference):
            continue
        for name in [*targets, "overall"]:
            before, after = average(by_case[reference], name), average(by_case[case], name)
            drops.append({"variant": case, "criterion": name, "reference": before, "variant_score": after})
            print(f"| {case} | {name} | {before:.1f} | {after:.1f} | {before - after:+.1f} |")
    differences = [abs(score(rows[0], n) - score(rows[1], n)) for rows in by_case.values() if len(rows) >= 2
                   for n in NAMES if isinstance(score(rows[0], n), int) and isinstance(score(rows[1], n), int)]
    # Every attempt costs, including a failed first attempt kept under `earlier`.
    calls = [attempt for r in results if r.get("call") for attempt in [r["call"], *r["call"].get("earlier", [])]]
    usage = {key: sum(((call.get("usage") or {}).get(key) or 0) for call in calls)
             for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}
    cost = sum(call.get("total_cost_usd") or 0 for call in calls)
    print(f"\nRepeat variance: mean |rep1 - rep2| {statistics.mean(differences):.2f}, max {max(differences)}, "
          f"over {len(differences)} paired scores" if differences else "")
    print(f"Judge calls: {len(calls)}; tokens {usage}; cost ${cost:.2f}; errors "
          f"{[r['case'] for r in results if r.get('error')]}")
    (args.out / "calibration.json").write_text(json.dumps(
        {"oracles": oracles, "drops": drops, "usage": usage, "costUsd": round(cost, 4), "calls": len(calls),
         "repeatDifferences": differences, "results": results}, indent=2))


if __name__ == "__main__":
    main()
