# Benchmark harness

Fixed-contract tasks for comparing coding workflows (bare coding, Spec Kit, BMAD and VISP) with the same worker model. Correctness is measured by hidden checks the worker never sees. Results are direction, not proof: few tasks, few repetitions. The results so far are in [the research summary](../docs/research-summary.md).

## Tasks

| Task | Kind | Hidden checks |
| --- | --- | --- |
| `reservations-api` | New HTTP service: inventory reservations with expiry, idempotency and concurrency | 36 core + 8 extended |
| `spreadsheet-cli` | New command-line spreadsheet engine: precedence, ranges, error order, cycles | 38 |
| `reservations-bundles` | Change to an existing multi-module service (`start/`) | 60, including the prior contract |
| `spreadsheet-extend` | Larger change to an existing multi-module engine (`start/`) | 37 regression + 26 new |

- `tasks/<task>/task.md` is the request every arm receives; `start/`, when present, is the existing codebase the project starts from.
- `tasks/<task>/hidden_test.py <project>` runs the project and prints JSON results.
- `reference/` holds correct implementations used only to validate the oracles; deliberately broken variants (a racy store, injected bugs) were checked to fail.

## Running

Runs, builds and worker homes live outside the repository, in `$VISP_BENCH_RUNS` (default `~/visp-bench`).

```bash
bench/build_visp.sh HEAD visp-head                          # freeze a VISP commit as a runnable build
python3 bench/setup_arm.py spreadsheet-cli bare r1          # or speckit | bmad | visp:visp-head | visp-codex:visp-head
python3 bench/run_claude.py r1                              # headless Claude Code worker (Haiku 4.5 by default)
python3 bench/run_codex.py r1                               # or a headless Codex worker (gpt-5.6-luna, low effort)
python3 bench/score.py spreadsheet-cli r1                   # hidden checks; writes runs/r1/hidden.json
```

- `setup_arm.py` creates a fresh Git project, installs the arm's workflow and writes the prompt. Spec Kit needs `specify` on `PATH`; BMAD is fetched with `npx`. VISP arms use a VISP-launched Codex reviewer and tester (`critic.launch: codex-exec`, medium effort), so the Codex CLI must be signed in. `--skill <id>` seeds and admits a bundled VISP skill, so two arms on the same build differ only by that skill.
- `run_claude.py` runs `claude -p` in the project with project settings only, so each workflow's own instructions, skills and hooks apply; Spec Kit's phases are sent as follow-up turns and BMAD's approval prompts are answered, as a user would.
- `run_codex.py` runs `codex exec` with a clean home holding only the Codex sign-in and a workspace-write sandbox with network, with project hooks trusted.
- Each writes `result.json` (duration, turns, tokens) beside the project.

A desktop app or terminal that ends its child processes can stop a long batch; start batches in their own session (for example `systemd-run --user` on Linux).
