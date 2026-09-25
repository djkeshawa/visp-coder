#!/bin/bash
# Freeze a VISP commit as a runnable build for benchmark arms.
# Usage: bench/build_visp.sh <git-ref> <name>
set -euo pipefail
ref=$1
name=$2
repo=$(cd "$(dirname "$0")/.." && pwd)
runs=${VISP_BENCH_RUNS:-$HOME/visp-bench}
build=$runs/builds/$name
mkdir -p "$runs/builds" "$runs/shims/$name"
# An exported tree, not a worktree, so builds leave no registration in the repository.
mkdir "$build"
git -C "$repo" archive "$ref" | tar -x -C "$build"
(cd "$build" && pnpm install --offline --frozen-lockfile --ignore-scripts >/dev/null && ./node_modules/.bin/tsup >/dev/null)
printf '#!/bin/bash\nexec %s %s/dist/cli.js "$@"\n' "$(command -v node)" "$build" >"$runs/shims/$name/visp"
chmod +x "$runs/shims/$name/visp"
"$runs/shims/$name/visp" --version
