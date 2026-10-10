"""Qualify spreadsheet acceptance oracles against correct and faulty programs.

Run from the repository root: python3 -m unittest bench/test_hidden_oracles.py
The checks use local reference copies and the standard library; no models are called.
"""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


BENCH = Path(__file__).resolve().parent
TASKS = (("spreadsheet-cli", "spreadsheet", 38),
         ("spreadsheet-extend", "spreadsheet-extend", 63))


class SpreadsheetOracleTests(unittest.TestCase):
    def score(self, task, project):
        completed = subprocess.run(
            [sys.executable, str(BENCH / "tasks" / task / "hidden_test.py"), str(project)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def copy_reference(self, reference, destination):
        shutil.copytree(BENCH / "reference" / reference, destination,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

    def test_correct_references_pass_every_acceptance_case(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                score = self.score(task, project)
                self.assertEqual((score["passed"], score["total"]), (total, total))

    def test_matching_output_with_nonzero_exit_fails_acceptance(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                launcher = project / "run.sh"
                launcher.rename(project / "run-original.sh")
                launcher.write_text('#!/bin/sh\n"$(dirname "$0")/run-original.sh"\nexit 42\n')
                launcher.chmod(0o755)
                score = self.score(task, project)
                self.assertEqual((score["passed"], score["total"]), (0, total))
                for result in score["results"]:
                    self.assertIn("42", str(result["detail"]))

    def test_incorrect_division_errors_fail_without_rejecting_all_cases(self):
        for task, reference, total in TASKS:
            with self.subTest(task=task), tempfile.TemporaryDirectory() as directory:
                project = Path(directory) / "project"
                self.copy_reference(reference, project)
                changed = False
                for path in project.rglob("*.py"):
                    original = path.read_text()
                    if "#DIV/0!" in original:
                        path.write_text(original.replace("#DIV/0!", "#BROKEN!"))
                        changed = True
                self.assertTrue(changed)
                score = self.score(task, project)
                self.assertEqual(score["total"], total)
                self.assertGreater(score["passed"], 0)
                self.assertLess(score["passed"], total)


if __name__ == "__main__":
    unittest.main()
