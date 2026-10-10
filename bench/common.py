"""Shared benchmark settings."""
import functools
import os
import pathlib
import shutil
import subprocess

# Runs, builds and worker homes live outside the repository.
RUNS = pathlib.Path(os.environ.get("VISP_BENCH_RUNS", pathlib.Path.home() / "visp-bench"))

# A worker sees only its own processes: `killall python3` or `pkill -f <pattern>` to stop its
# test server must not reach the runner or another run's servers. The namespace ends with it.
UNSHARE = ["unshare", "--user", "--map-current-user", "--pid", "--fork", "--mount-proc", "--kill-child"]


@functools.cache
def isolate():
    """The namespace wrapper, or [] where unshare is missing or the host blocks it.

    Unprivileged user namespaces or mounting /proc can be disabled even when unshare exists;
    the exact wrapper is tried once so a blocked host runs workers unwrapped instead of not at all.
    """
    if not shutil.which("unshare"):
        return []
    try:
        probe = subprocess.run([*UNSHARE, "true"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return UNSHARE if probe.returncode == 0 else []
