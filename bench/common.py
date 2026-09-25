"""Shared benchmark settings."""
import os
import pathlib

# Runs, builds and worker homes live outside the repository.
RUNS = pathlib.Path(os.environ.get("VISP_BENCH_RUNS", pathlib.Path.home() / "visp-bench"))
